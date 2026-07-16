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
const pluginRoot = path.dirname(path.dirname(hookScript));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nerd-out-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(directory, config = validConfig()) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "nerd-out-journal.json"),
    JSON.stringify(config),
  );
  return directory;
}

function makeConfigDirectory(config = validConfig()) {
  return writeConfig(makeTemporaryDirectory(), config);
}

function makeEmptyConfigDirectory() {
  return makeTemporaryDirectory();
}

function validConfig() {
  return {
    version: 1,
    scope: "global",
    workspace: { id: "workspace-id", name: "Journal" },
    journal: { dailyNote: true },
  };
}

function cleanEnvironment() {
  const environment = { ...process.env };
  delete environment.CLAUDE_CONFIG_DIR;
  delete environment.CLAUDE_PLUGIN_ROOT;
  delete environment.CODEX_HOME;
  delete environment.PLUGIN_ROOT;
  return environment;
}

function runHook({
  environment,
  input = { hook_event_name: "UserPromptSubmit" },
  script = hookScript,
}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: environment,
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
}

test("injects the Codex journal skill when Codex config is valid", () => {
  const configDirectory = makeConfigDirectory();
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: configDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
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
  assert.equal(
    output.hookSpecificOutput.additionalContext.includes(configDirectory),
    false,
  );
});

test("tells the agent to recall from the configured journal workspace", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /"Journal"/);
  assert.match(context, /workspaceId workspace-id/);
  assert.match(context, /keyword_search\/semantic_search/);
  assert.match(context, /read the relevant notes before deciding/);
});

test("injects the namespaced Claude Code skill when its config is valid", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: makeConfigDirectory(),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /\/nerd-out-notes:nerd-out-journal/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Claude Code/);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /keyword_search\/semantic_search/,
  );
});

test("stays silent when the config is missing", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeEmptyConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("stays silent when the config is malformed", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory({ version: 1 }),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("stays silent when hook input is invalid JSON", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
    input: "not-json",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("defaults an omitted daily note setting to enabled", () => {
  const config = validConfig();
  delete config.journal;

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.notEqual(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("uses the Codex home-directory fallback", () => {
  const homeDirectory = makeTemporaryDirectory();
  writeConfig(path.join(homeDirectory, ".codex"));

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      HOME: homeDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\$nerd-out-notes:nerd-out-journal/);
  assert.equal(result.stderr, "");
});

test("uses the Claude Code home-directory fallback", () => {
  const homeDirectory = makeTemporaryDirectory();
  writeConfig(path.join(homeDirectory, ".claude"));

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      HOME: homeDirectory,
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\/nerd-out-notes:nerd-out-journal/);
  assert.equal(result.stderr, "");
});

test("stays silent when the Codex home fallback has no config", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      HOME: makeTemporaryDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("stays silent when the Claude Code home fallback has no config", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      HOME: makeTemporaryDirectory(),
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("runs when the plugin root is reached through a symlink", () => {
  const cacheDirectory = makeTemporaryDirectory();
  const linkedPluginRoot = path.join(cacheDirectory, "latest");
  fs.symlinkSync(pluginRoot, linkedPluginRoot, "dir");

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: linkedPluginRoot,
    },
    script: path.join(linkedPluginRoot, "hooks/journal-context.mjs"),
  });

  assert.equal(result.status, 0);
  assert.notEqual(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("ignores hook events other than UserPromptSubmit", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "SessionStart" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
