import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hookScript = path.join(
  repositoryRoot,
  "plugins/nerd-out-notes/hooks/journal-context.mjs",
);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeConfigDirectory(config) {
  if (arguments.length === 0) config = validConfig();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nerd-out-journal-"));
  temporaryDirectories.push(directory);
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(directory, "nerd-out-journal.json"),
      JSON.stringify(config),
    );
  }
  return directory;
}

function validConfig() {
  return {
    version: 1,
    scope: "global",
    workspace: { id: "workspace-id", name: "Journal" },
    journal: { dailyNote: true },
  };
}

function runHook(environment) {
  return spawnSync(process.execPath, [hookScript], {
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
  });
}

test("injects the Codex journal skill when Codex config is valid", () => {
  const result = runHook({
    ...process.env,
    CODEX_HOME: makeConfigDirectory(),
    PLUGIN_ROOT: path.dirname(path.dirname(hookScript)),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /\$nerd-out-notes:nerd-out-journal/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Codex/);
});

test("injects the namespaced Claude Code skill when its config is valid", () => {
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: makeConfigDirectory(),
    CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(hookScript)),
  };
  delete environment.CODEX_HOME;
  delete environment.PLUGIN_ROOT;

  const result = runHook(environment);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /\/nerd-out-notes:nerd-out-journal/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Claude Code/);
});

test("stays silent when the config is missing", () => {
  const result = runHook({
    ...process.env,
    CODEX_HOME: makeConfigDirectory(undefined),
    PLUGIN_ROOT: path.dirname(path.dirname(hookScript)),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("stays silent when the config is malformed", () => {
  const result = runHook({
    ...process.env,
    CODEX_HOME: makeConfigDirectory({ version: 1 }),
    PLUGIN_ROOT: path.dirname(path.dirname(hookScript)),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
