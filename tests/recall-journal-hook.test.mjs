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
  "plugins/recall/hooks/journal-context.mjs",
);
const pluginRoot = path.dirname(path.dirname(hookScript));
const GIT_TEST_TIMEOUT_MS = 10_000;
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(directory, config = validConfig()) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "recall-journal.json"),
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

function validV2Config() {
  return {
    version: 2,
    journal: { dailyNote: true },
    global: {
      workspace: { id: "workspace-id", name: "Journal" },
    },
  };
}

function recallProject(id = "recall-project-id", name = "Roadmap") {
  return { id, name };
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

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TEST_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
  );
  return result.stdout;
}

function makeRepositoryWithLinkedWorktree() {
  const mainCheckout = makeProjectDirectory("main-checkout");
  const nestedProject = path.join(mainCheckout, "packages", "app");
  fs.mkdirSync(nestedProject, { recursive: true });
  fs.writeFileSync(path.join(nestedProject, "README.md"), "# Test project\n");
  runGit(mainCheckout, "init", "--quiet");
  runGit(mainCheckout, "add", "packages/app/README.md");
  runGit(
    mainCheckout,
    "-c",
    "user.name=Recall Tests",
    "-c",
    "user.email=tests@recall.test",
    "commit",
    "--no-gpg-sign",
    "--quiet",
    "-m",
    "Initial test fixture",
  );

  const linkedWorktree = path.join(
    makeTemporaryDirectory(),
    "agent-worktrees",
    "linked-checkout",
  );
  fs.mkdirSync(path.dirname(linkedWorktree), { recursive: true });
  runGit(
    mainCheckout,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    linkedWorktree,
    "HEAD",
  );
  return { linkedWorktree, mainCheckout, nestedProject };
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
    /\$recall:recall-journal/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Codex/);
  assert.equal(
    output.hookSpecificOutput.additionalContext.includes(configDirectory),
    false,
  );
});

test("accepts a v2 global destination without a Recall Project", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(validV2Config()),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId workspace-id/);
  assert.match(context, /does not select a Recall Project/);
  assert.equal(context.includes("projectId"), false);
});

test("injects the configured Recall Project and exact named-note targeting", () => {
  const config = validV2Config();
  config.global.recallProject = recallProject();

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /Recall Project "Roadmap"/);
  assert.match(context, /projectId recall-project-id/);
  assert.match(context, /pass both workspaceId workspace-id and projectId recall-project-id/);
  assert.match(context, /DailyNote workspace-level/);
});

test("activates a project-only v2 config only inside the configured filesystem project", () => {
  const projectRoot = makeTemporaryDirectory();
  const config = {
    version: 2,
    journal: { dailyNote: true },
    projects: {
      [projectRoot]: {
        recallProject: recallProject("repo-project", "Repository"),
        workspace: { id: "repo-workspace", name: "Engineering" },
      },
    },
  };
  const configDirectory = makeConfigDirectory(config);

  const inside = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: configDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
  });
  assert.match(inside.stdout, /workspaceId repo-workspace/);
  assert.match(inside.stdout, /projectId repo-project/);
  assert.equal(inside.stdout.includes(projectRoot), false);

  const outside = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: configDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: makeTemporaryDirectory(),
    },
  });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, "");
});

test("prefers a v2 filesystem-project destination and its Recall Project over global", () => {
  const projectRoot = makeTemporaryDirectory();
  const config = validV2Config();
  config.global.recallProject = recallProject("global-project", "Global Project");
  config.projects = {
    [projectRoot]: {
      recallProject: recallProject("repo-project", "Repository"),
      workspace: { id: "repo-workspace", name: "Engineering" },
    },
  };

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
  });

  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId repo-workspace/);
  assert.match(context, /projectId repo-project/);
  assert.match(context, /per-project override/);
  assert.equal(context.includes("pass both workspaceId workspace-id"), false);
});

test("rejects invalid v2 destinations and explicit null Recall Projects", () => {
  const projectRoot = makeTemporaryDirectory();
  const malformed = [
    { version: 2, global: { workspace: validProjectWorkspace(), recallProject: null } },
    { version: 2, global: null },
    { version: 2, projects: {} },
    {
      version: 2,
      projects: {
        [projectRoot]: {
          recallProject: { id: "bad id", name: "Project" },
          workspace: validProjectWorkspace(),
        },
      },
    },
  ];

  for (const config of malformed) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
      input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", JSON.stringify(config));
  }
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

test("tells the agent to open, update, and finalize the entry live", () => {
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
  assert.match(context, /when substantive work begins/);
  assert.match(context, /fresh task marker after recall/);
  assert.match(context, /progress updates at checkpoints/);
  assert.match(context, /finalize the entry before the final response/);
  assert.match(context, /Skip trivial acknowledgements/);
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
    /\/recall:recall-journal/,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Claude Code/);
  assert.match(output.hookSpecificOutput.additionalContext, /keyword_search/);
  assert.match(output.hookSpecificOutput.additionalContext, /semantic_search/);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /progress updates at checkpoints/,
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
  assert.match(result.stdout, /\$recall:recall-journal/);
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
  assert.match(result.stdout, /\/recall:recall-journal/);
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

test("maps an external Codex worktree to its main checkout project", () => {
  const { linkedWorktree, mainCheckout } = makeRepositoryWithLinkedWorktree();
  const workingDirectory = path.join(linkedWorktree, "packages", "app");

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(mainCheckout)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: workingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId project-workspace-id/);
  assert.match(context, /Codex/);
  assert.equal(context.includes("workspaceId workspace-id"), false);
});

test("maps an external Claude Code worktree to a nested project root", () => {
  const { linkedWorktree, nestedProject } = makeRepositoryWithLinkedWorktree();
  const workingDirectory = path.join(linkedWorktree, "packages", "app");

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: makeConfigDirectory(configWithProject(nestedProject)),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: workingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId project-workspace-id/);
  assert.match(context, /Claude Code/);
  assert.equal(context.includes("workspaceId workspace-id"), false);
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

test("keeps filesystem matching when Git is unavailable", () => {
  const projectRoot = makeTemporaryDirectory();
  const nestedDirectory = path.join(projectRoot, "nested");
  fs.mkdirSync(nestedDirectory);

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PATH: "",
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: nestedDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /workspaceId project-workspace-id/);
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

test("resolves a relative input cwd against the hook process cwd", () => {
  const projectRoot = makeTemporaryDirectory();
  const nestedProject = path.join(projectRoot, "nested");
  fs.mkdirSync(nestedProject);

  const result = runHook({
    cwd: projectRoot,
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(nestedProject)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: "nested" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /workspaceId project-workspace-id/);
});

test("normalizes dot segments in the input cwd", () => {
  const projectRoot = makeTemporaryDirectory();
  const workingDirectory = path.join(projectRoot, "a", "b");
  fs.mkdirSync(workingDirectory, { recursive: true });
  const dottedDirectory = path.join(projectRoot, "a", "..", "a", "b");

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(configWithProject(projectRoot)),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: dottedDirectory },
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
  const absoluteRoot = path.join(os.tmpdir(), "recall-project");
  const malformedProjects = [
    [],
    { "relative/path": { workspace: validProjectWorkspace() } },
    { "/": { workspace: validProjectWorkspace() } },
    { "/..": { workspace: validProjectWorkspace() } },
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
