import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyRecallHook } from "../plugins/recall/skills/recall-journal/scripts/codex-hook-status.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginRoot = path.join(repositoryRoot, "plugins", "recall");
const hookSourcePath = path.join(pluginRoot, "hooks", "hooks.json");
const helperScript = path.join(
  pluginRoot,
  "skills",
  "recall-journal",
  "scripts",
  "codex-hook-status.mjs",
);
const helperWrapper = path.join(
  pluginRoot,
  "skills",
  "recall-journal",
  "scripts",
  "check-codex-hook",
);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "recall-hooks-list-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function hook(overrides = {}) {
  return {
    key: "recall@recall:hooks/hooks.json:user_prompt_submit:0:0",
    eventName: "userPromptSubmit",
    handlerType: "command",
    sourcePath: hookSourcePath,
    source: "plugin",
    enabled: true,
    isManaged: false,
    trustStatus: "trusted",
    ...overrides,
  };
}

function response(hooks, overrides = {}) {
  return {
    data: [
      {
        cwd: repositoryRoot,
        hooks,
        warnings: [],
        errors: [],
        ...overrides,
      },
    ],
  };
}

test("classifies trusted and managed Recall hooks as ready", () => {
  for (const trustStatus of ["trusted", "managed"]) {
    const result = classifyRecallHook(response([hook({ trustStatus })]));
    assert.equal(result.status, trustStatus);
    assert.equal(result.hook.enabled, true);
    assert.equal(result.hook.trustStatus, trustStatus);
  }
});

test("classifies hooks that need user review", () => {
  for (const trustStatus of ["untrusted", "modified"]) {
    const result = classifyRecallHook(response([hook({ trustStatus })]));
    assert.equal(result.status, trustStatus);
  }
});

test("reports a disabled Recall hook before its trust state", () => {
  const result = classifyRecallHook(
    response([hook({ enabled: false, trustStatus: "untrusted" })]),
  );
  assert.equal(result.status, "disabled");
  assert.equal(result.hook.enabled, false);
});

test("matches the hook bundled beside the skill, not another plugin hook", () => {
  const otherHook = hook({
    key: "other@marketplace:hooks/hooks.json:user_prompt_submit:0:0",
    sourcePath: path.join(makeTemporaryDirectory(), "hooks.json"),
  });
  const result = classifyRecallHook(response([otherHook, hook()]));
  assert.equal(result.status, "trusted");
  assert.match(result.hook.key, /^recall@recall:/);
});

test("reports missing and ambiguous hook inventories with diagnostics", () => {
  const missing = classifyRecallHook(
    response([], {
      warnings: ["plugin warning"],
      errors: [{ path: hookSourcePath, message: "plugin error" }],
    }),
  );
  assert.deepEqual(missing, {
    status: "missing",
    warnings: ["plugin warning"],
    errors: ["plugin error"],
  });

  const ambiguous = classifyRecallHook(response([hook(), hook()]));
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.matchCount, 2);
});

test("queries hooks/list only after the Codex handshake", () => {
  const binDirectory = makeTemporaryDirectory();
  const fakeCodex = path.join(binDirectory, "codex");
  const fakeResponse = response([hook({ trustStatus: "modified" })]);
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import readline from "node:readline";

let initialized = false;
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "initialized") {
    initialized = true;
  } else if (message.method === "hooks/list") {
    if (!initialized) {
      send({ id: message.id, error: { message: "Not initialized" } });
    } else {
      send({ id: message.id, result: ${JSON.stringify(fakeResponse)} });
    }
  }
});
`,
  );
  fs.chmodSync(fakeCodex, 0o755);

  const result = spawnSync(helperWrapper, [], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CLI_PATH: fakeCodex,
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "modified");
  assert.equal(output.hook.trustStatus, "modified");
});

test("returns structured guidance when the Codex executable is unavailable", () => {
  const emptyPath = makeTemporaryDirectory();
  const environment = { ...process.env, PATH: emptyPath };
  delete environment.CODEX_CLI_PATH;
  const result = spawnSync(process.execPath, [helperScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "unavailable");
  assert.match(output.reason, /Could not start the Codex App Server/);
});
