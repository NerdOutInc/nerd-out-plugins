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

function validProjectWorkspace() {
  return { id: "project-workspace-id", name: "Project Journal" };
}

function configWithProject(projectRoot, workspace = validProjectWorkspace()) {
  const config = validConfig();
  config.projects = { [projectRoot]: { workspace } };
  return config;
}

function makeProjectDirectory(...segments) {
  const directory = path.join(makeTemporaryDirectory(), ...segments);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
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
  cwd,
  environment,
  input = { hook_event_name: "UserPromptSubmit" },
  script = hookScript,
}) {
  return spawnSync(process.execPath, [script], {
    cwd,
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
  assert.match(context, /keyword_search/);
  assert.match(context, /semantic_search/);
  assert.match(context, /read the relevant notes before deciding/);
});

test("flattens and truncates workspace names in the injected context", () => {
  const config = validConfig();
  config.workspace.name = `A\nB\t${"x".repeat(100)}`;

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context.includes("\n"), false);
  assert.equal(context.includes(`"A B ${"x".repeat(76)}"`), true);
  assert.equal(context.includes("x".repeat(77)), false);
});

test("escapes quotes and backslashes in the workspace name", () => {
  const config = validConfig();
  config.workspace.name = 'Side "quotes" \\ slash';

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context.includes(JSON.stringify(config.workspace.name)), true);
});

test("stays silent when the workspace id is not a plain token", () => {
  for (const id of ["workspace\nid", "workspace id", 'ws"quote', "w".repeat(129)]) {
    const config = validConfig();
    config.workspace.id = id;

    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", `expected silence for id ${JSON.stringify(id)}`);
    assert.equal(result.stderr, "");
  }
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
  assert.match(output.hookSpecificOutput.additionalContext, /keyword_search/);
  assert.match(output.hookSpecificOutput.additionalContext, /semantic_search/);
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

test("binds the session to a project workspace when cwd is inside the project", () => {
  const projectRoot = makeTemporaryDirectory();
  const nestedDirectory = path.join(projectRoot, "packages", "app");
  fs.mkdirSync(nestedDirectory, { recursive: true });

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: nestedDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /"Project Journal"/);
  assert.match(context, /workspaceId project-workspace-id/);
  assert.match(context, /per-project override of the global workspace "Journal"/);
  assert.equal(context.includes("workspaceId workspace-id"), false);
  assert.equal(context.includes(projectRoot), false);
});

test("binds the session when cwd is exactly the project root", () => {
  const projectRoot = makeTemporaryDirectory();

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: makeConfigDirectory(configWithProject(projectRoot)),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId project-workspace-id/);
  assert.match(context, /Claude Code/);
});

test("keeps the global workspace when the session is outside every project", () => {
  const projectRoot = makeTemporaryDirectory();
  const unrelatedDirectory = makeTemporaryDirectory();

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: unrelatedDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /"Journal"/);
  assert.match(context, /workspaceId workspace-id/);
  assert.equal(context.includes("per-project override"), false);
  assert.equal(context.includes("project-workspace-id"), false);
});

test("does not match a sibling directory that shares the root's prefix", () => {
  const parentDirectory = makeTemporaryDirectory();
  const projectRoot = path.join(parentDirectory, "proj");
  const siblingDirectory = path.join(parentDirectory, "project-two");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(siblingDirectory);

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: siblingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId workspace-id/);
  assert.equal(context.includes("project-workspace-id"), false);
});

test("prefers the longest matching project root when projects nest", () => {
  const outerRoot = makeTemporaryDirectory();
  const innerRoot = path.join(outerRoot, "inner");
  const workingDirectory = path.join(innerRoot, "deep");
  fs.mkdirSync(workingDirectory, { recursive: true });

  const config = validConfig();
  config.projects = {
    [outerRoot]: { workspace: { id: "outer-id", name: "Outer" } },
    [innerRoot]: { workspace: { id: "inner-id", name: "Inner" } },
  };

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: workingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /"Inner"/);
  assert.match(context, /workspaceId inner-id/);
  assert.equal(context.includes("workspaceId outer-id"), false);
});

test("matches a project root saved through a symlink", () => {
  const projectRoot = makeTemporaryDirectory();
  const workingDirectory = path.join(projectRoot, "src");
  fs.mkdirSync(workingDirectory);
  const linkedRoot = path.join(makeTemporaryDirectory(), "linked");
  fs.symlinkSync(projectRoot, linkedRoot, "dir");

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(linkedRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: workingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /workspaceId project-workspace-id/);
});

test("falls back to the hook process cwd when the input has none", () => {
  const projectRoot = makeProjectDirectory("repo");

  const result = runHook({
    cwd: projectRoot,
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /workspaceId project-workspace-id/);
});

test("treats an empty projects map as global journaling", () => {
  const config = validConfig();
  config.projects = {};

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /workspaceId workspace-id/);
});

test("stays silent when the projects map is malformed", () => {
  const absoluteRoot = path.join(os.tmpdir(), "nerd-out-project");
  const malformedProjects = [
    [],
    { "relative/path": { workspace: validProjectWorkspace() } },
    { [absoluteRoot]: null },
    { [absoluteRoot]: {} },
    { [absoluteRoot]: { workspace: { id: "bad id", name: "Project" } } },
    { [absoluteRoot]: { workspace: { id: "project-id", name: "" } } },
  ];

  for (const projects of malformedProjects) {
    const config = validConfig();
    config.projects = projects;

    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
      input: { hook_event_name: "UserPromptSubmit", cwd: absoluteRoot },
    });

    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      "",
      `expected silence for projects ${JSON.stringify(projects)}`,
    );
    assert.equal(result.stderr, "");
  }
});

test("sanitizes the project workspace name in the injected context", () => {
  const projectRoot = makeTemporaryDirectory();
  const config = configWithProject(projectRoot, {
    id: "project-workspace-id",
    name: 'Line\nbreak "quoted"',
  });

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context.includes("\n"), false);
  assert.equal(context.includes(JSON.stringify('Line break "quoted"')), true);
});
