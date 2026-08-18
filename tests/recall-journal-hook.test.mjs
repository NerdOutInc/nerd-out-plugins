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
const fixtureRoot = path.join(
  repositoryRoot,
  "tests/fixtures/recall-journal-hook",
);
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

function validV3Config() {
  return {
    version: 3,
    projectMemory: { enabled: true },
  };
}

function validV4Config() {
  return {
    version: 4,
    projectMemory: {
      enabled: true,
      defaultProject: {
        workspace: { id: "default-workspace-id", name: "General Memory" },
        recallProject: { id: "default-project-id", name: "General" },
      },
    },
  };
}

function readFixture(version, filename) {
  return fs
    .readFileSync(path.join(fixtureRoot, version, filename), "utf8")
    .trimEnd();
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

test("keeps legacy v1 and v2 hook context byte-for-byte compatible", () => {
  for (const version of ["v1", "v2"]) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: path.join(fixtureRoot, version),
        PLUGIN_ROOT: pluginRoot,
      },
    });

    assert.equal(result.status, 0, version);
    assert.equal(result.stderr, "", version);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.equal(context, readFixture(version, "additional-context.txt"));
  }
});

test("routes a strict v3 config to structured project memory only", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v3"),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v3", "additional-context.txt"));
  assert.match(context, /resolve_project/);
  assert.match(context, /get_project_context/);
  assert.match(context, /structured-memory-only/);
  for (const legacyInstruction of [
    "workspaceId",
    "projectId",
    "create_today_note",
    "exactly one journal note",
    "toggle entries",
    "$recall:recall-journal",
    "list_note_activity",
    "read_note",
    "update_note_content",
    "expectedRevision",
  ]) {
    assert.equal(context.includes(legacyInstruction), false, legacyInstruction);
  }
});

test("uses the host-specific name in v3 without changing its protocol", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v3"),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(
    context,
    readFixture("v3", "additional-context.txt").replace("Codex", "Claude Code"),
  );
});

test("rejects malformed or mixed v3 configs instead of choosing a journal protocol", () => {
  const malformed = [
    { version: 3 },
    { version: 3, projectMemory: null },
    { version: 3, projectMemory: { enabled: false } },
    { version: 3, projectMemory: { enabled: true, fallback: "legacy" } },
    { ...validV3Config(), journal: { dailyNote: false } },
    { ...validV3Config(), global: validV2Config().global },
    { ...validV3Config(), projects: {} },
    { ...validV3Config(), scope: "global" },
    { ...validV3Config(), workspace: validProjectWorkspace() },
  ];

  for (const config of malformed) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
    });

    assert.equal(result.status, 0, JSON.stringify(config));
    assert.equal(result.stderr, "", JSON.stringify(config));
    assert.equal(result.stdout, "", JSON.stringify(config));
  }
});

test("uses repository-first v4 routing without exposing the default Project", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v4"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v4", "repository-context.txt"));
  assert.match(context, /repository-first routing/);
  assert.match(context, /resolve_project/);
  assert.match(context, /get_project_context/);
  assert.match(context, /none, ambiguous, or not_ready/);
  assert.equal(context.includes("default-workspace-id"), false);
  assert.equal(context.includes("default-project-id"), false);
  assert.equal(context.includes("General Memory"), false);
});

test("uses the explicit v4 default only when no repository identity exists", () => {
  const noRepository = makeTemporaryDirectory();
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v4"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: noRepository },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v4", "no-repository-context.txt"));
  assert.match(context, /projectUuid default-project-id/);
  assert.match(context, /Do not call resolve_project/);
  assert.match(context, /proved no-repository route/);
  assert.match(context, /none, ambiguous, or not_ready/);
});

test("keeps a v4 repository with no remote on the repository-first route", () => {
  const repository = makeProjectDirectory("repository-without-origin");
  runGit(repository, "init", "--quiet");
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v4"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: repository },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v4", "repository-context.txt"));
  assert.match(context, /If there is no supported remote/);
  assert.equal(context.includes("default-project-id"), false);
});

test("withholds the v4 default when repository identity cannot be proved", () => {
  const missingDirectory = path.join(
    makeTemporaryDirectory(),
    "missing-working-directory",
  );
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v4"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: missingDirectory },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(
    context,
    /could not prove whether filesystem repository identity exists/,
  );
  assert.match(context, /Continue without project memory/);
  assert.equal(context.includes("default-workspace-id"), false);
  assert.equal(context.includes("default-project-id"), false);
});

test("uses the host-specific name in v4 without changing its routing", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v4"),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(
    context,
    readFixture("v4", "repository-context.txt").replace("Codex", "Claude Code"),
  );
});

test("rejects malformed or mixed v4 configs instead of choosing a memory protocol", () => {
  const malformed = [
    { version: 4 },
    { version: 4, projectMemory: null },
    { version: 4, projectMemory: { enabled: true } },
    {
      version: 4,
      projectMemory: { enabled: false, defaultProject: {} },
    },
    {
      version: 4,
      projectMemory: {
        enabled: true,
        defaultProject: {
          workspace: validV2Config().global.workspace,
        },
      },
    },
    {
      version: 4,
      projectMemory: {
        enabled: true,
        defaultProject: {
          workspace: validV2Config().global.workspace,
          recallProject: null,
        },
      },
    },
    {
      version: 4,
      projectMemory: {
        enabled: true,
        defaultProject: {
          workspace: { id: "bad id", name: "Workspace" },
          recallProject: recallProject(),
        },
      },
    },
    {
      version: 4,
      projectMemory: {
        enabled: true,
        defaultProject: validV4Config().projectMemory.defaultProject,
        fallback: "legacy",
      },
    },
    { ...validV4Config(), journal: { dailyNote: false } },
    { ...validV4Config(), global: validV2Config().global },
    { ...validV4Config(), projects: {} },
  ];

  for (const config of malformed) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
      input: { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
    });

    assert.equal(result.status, 0, JSON.stringify(config));
    assert.equal(result.stderr, "", JSON.stringify(config));
    assert.equal(result.stdout, "", JSON.stringify(config));
  }
});

test("documents v3 and v4 as reader-only while keeping v1/v2 as the sole writer", () => {
  const [skill, configuration] = [
    "plugins/recall/skills/recall-journal/SKILL.md",
    "plugins/recall/skills/recall-journal/references/configuration.md",
  ].map((relativePath) =>
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );

  assert.match(
    skill,
    /reader-only \*\*version 3 and version 4 structured\s+project\s+memory\*\*/,
  );
  assert.match(
    skill,
    /never create or update a legacy journal note or Today summary/,
  );
  assert.match(configuration, /"projectMemory": \{ "enabled": true \}/);
  assert.match(configuration, /"version": 4/);
  assert.match(
    configuration,
    /Current setup and\s+reconfiguration flows below continue to write version 2 only/,
  );
  assert.match(configuration, /Never auto-migrate a version 1 or 2 config/);
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

test("injects the Today summary target without exposing a config path", () => {
  const config = validV2Config();
  config.journal = { dailyNote: false, summaryTarget: "today" };
  const configDirectory = makeConfigDirectory(config);
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: configDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /summary target is the Today timeline/);
  assert.match(context, /create_today_note/);
  assert.match(context, /idempotencyKey/);
  assert.match(context, /### Full journal entry/);
  assert.match(context, /workspaceId workspace-id/);
  assert.equal(context.includes(configDirectory), false);
});

test("keys the Today card by thread id only when the host provides one", () => {
  const config = validV2Config();
  config.journal = { dailyNote: false, summaryTarget: "today" };
  const configDirectory = makeConfigDirectory(config);
  const environment = {
    ...cleanEnvironment(),
    CODEX_HOME: configDirectory,
    PLUGIN_ROOT: pluginRoot,
  };

  const withThread = runHook({
    environment,
    input: { hook_event_name: "UserPromptSubmit", session_id: "thread-123" },
  });
  assert.match(
    JSON.parse(withThread.stdout).hookSpecificOutput.additionalContext,
    /the thread id plus the date as idempotencyKey/,
  );

  const withoutThread = runHook({ environment });
  assert.match(
    JSON.parse(withoutThread.stdout).hookSpecificOutput.additionalContext,
    /the thread's first journal marker plus the date as idempotencyKey/,
  );
});

test("passes the configured Recall Project to Today summaries", () => {
  const config = validV2Config();
  config.journal = { dailyNote: false, summaryTarget: "today" };
  config.global.recallProject = recallProject();
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.match(result.stdout, /create_today_note/);
  assert.match(result.stdout, /projectId recall-project-id/);
});

test("injects none for legacy dailyNote false and explicit summaryTarget none", () => {
  for (const journal of [
    { dailyNote: false },
    { dailyNote: false, summaryTarget: "none" },
  ]) {
    const config = validV2Config();
    config.journal = journal;
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
    });

    assert.match(result.stdout, /disables day-summary notes/);
  }
});

test("marks every dailyNote-mapped summary target for one-time migration", () => {
  const v2Canonical = validV2Config();
  v2Canonical.journal = { dailyNote: true, summaryTarget: "dailyNote" };
  const v2OmittedJournal = validV2Config();
  delete v2OmittedJournal.journal;

  for (const config of [
    validConfig(),
    validV2Config(),
    v2Canonical,
    v2OmittedJournal,
  ]) {
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
    const label = JSON.stringify(config.journal);
    assert.match(context, /Recall server has retired/, label);
    assert.match(context, /never write or append a DailyNote summary/, label);
    assert.match(
      context,
      /Today timeline \(offered only when create_today_note is advertised\) or to no day summary/,
      label,
    );
    assert.match(context, /migration flow in \$recall:recall-journal/, label);
    assert.equal(
      context.includes("keep the DailyNote workspace-level"),
      false,
      label,
    );
  }
});

test("rejects missing, contradictory, or unknown v2 summary target compatibility values", () => {
  for (const journal of [
    { summaryTarget: "today" },
    { summaryTarget: "dailyNote" },
    { summaryTarget: "none" },
    { dailyNote: true, summaryTarget: "today" },
    { dailyNote: false, summaryTarget: "dailyNote" },
    { dailyNote: true, summaryTarget: "none" },
    { dailyNote: false, summaryTarget: "tomorrow" },
  ]) {
    const config = validV2Config();
    config.journal = journal;
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
    });

    assert.equal(result.stdout, "");
  }
});

test("keeps v1 project entries workspace-only when newer fields are malformed", () => {
  const projectRoot = makeTemporaryDirectory();
  const config = configWithProject(projectRoot);
  config.projects[projectRoot].recallProject = null;

  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(config),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: projectRoot },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /workspaceId project-workspace-id/);
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
  assert.match(
    context,
    /pass both workspaceId workspace-id and projectId recall-project-id/,
  );
  assert.match(context, /never write or append a DailyNote summary/);
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
  config.global.recallProject = recallProject(
    "global-project",
    "Global Project",
  );
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
    {
      version: 2,
      global: { workspace: validProjectWorkspace(), recallProject: null },
    },
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
  assert.match(context, /exactly one journal note/);
  assert.match(context, /toggle entries at checkpoints/);
  assert.match(context, /wrap up the entry before the final response/);
  assert.match(context, /Skip trivial acknowledgements/);
});

test("injects the host session id as the thread's journal identity", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      session_id: "b425db1a-153d-45d2-850c-93ac0271f495",
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /stable id is b425db1a-153d-45d2-850c-93ac0271f495/);
  assert.match(context, /anchors the thread's single journal note/);
});

test("accepts a thread_id when no session_id is provided", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", thread_id: "thread-123" },
  });

  assert.equal(result.status, 0);
  assert.match(
    JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    /stable id is thread-123/,
  );
});

test("omits the thread identity when the session id is not a plain token", () => {
  for (const sessionId of [
    "bad id",
    "line\nbreak",
    "thread-123\n",
    "w".repeat(129),
    42,
  ]) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(),
        PLUGIN_ROOT: pluginRoot,
      },
      input: { hook_event_name: "UserPromptSubmit", session_id: sessionId },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    const label = JSON.stringify(sessionId);
    assert.equal(context.includes("stable id"), false, label);
    if (typeof sessionId === "string") {
      assert.equal(context.includes(sessionId), false, label);
    }
  }
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
  for (const id of [
    "workspace\nid",
    "workspace id",
    'ws"quote',
    "w".repeat(129),
  ]) {
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
    assert.equal(
      result.stdout,
      "",
      `expected silence for id ${JSON.stringify(id)}`,
    );
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
    /toggle entries at checkpoints/,
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

test("maps an omitted daily note setting to the retired-target migration", () => {
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
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /Recall server has retired/);
  assert.match(context, /never write or append a DailyNote summary/);
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
  assert.match(
    context,
    /per-project override of the global workspace "Journal"/,
  );
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

const v5ThreadId = "11111111-2222-4333-8444-555555555555";

test("uses repository-first v5 routing without exposing the default Project", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: repositoryRoot,
      session_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v5", "repository-context.txt"));
  assert.match(context, /repository-first routing/);
  assert.match(context, /none, ambiguous, or not_ready/);
  assert.equal(context.includes("default-workspace-id"), false);
  assert.equal(context.includes("default-project-id"), false);
  assert.equal(context.includes("General Memory"), false);
});

test("uses the explicit v5 default only when no repository identity exists", () => {
  const noRepository = makeTemporaryDirectory();
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: noRepository,
      session_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(context, readFixture("v5", "no-repository-context.txt"));
  assert.match(context, /default-project-id/);
});

test("withholds the v5 default when repository identity cannot be proved", () => {
  const missingDirectory = path.join(
    makeTemporaryDirectory(),
    "missing-working-directory",
  );
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: missingDirectory,
      session_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(
    context,
    /could not prove whether filesystem repository identity exists/,
  );
  assert.equal(context.includes("default-workspace-id"), false);
  assert.equal(context.includes("default-project-id"), false);
});

test("v5 names the session tools and never the retired card recipe", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: repositoryRoot,
      session_id: v5ThreadId,
    },
  });

  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /open_session/);
  assert.match(context, /append_entry/);
  assert.match(context, /close_session/);
  assert.match(context, /daySummary/);
  // The mechanics this version exists to retire must never be recited again.
  assert.equal(context.includes("create_today_note"), false);
  assert.equal(context.includes("### Full journal entry"), false);
  assert.equal(context.includes("idempotencyKey"), false);
  assert.equal(context.includes("journal marker"), false);
});

test("v5 carries the thread id as the session lineage key", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "UserPromptSubmit",
      cwd: repositoryRoot,
      session_id: v5ThreadId,
    },
  });

  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, new RegExp(`lineageKey ${v5ThreadId}`));
});

test("v5 opens without a lineage key rather than inventing one", () => {
  for (const input of [
    { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
    {
      hook_event_name: "UserPromptSubmit",
      cwd: repositoryRoot,
      session_id: "not a valid id",
    },
  ]) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: path.join(fixtureRoot, "v5"),
        PLUGIN_ROOT: pluginRoot,
      },
      input,
    });

    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(context, /without a lineageKey; never invent one/);
    assert.equal(context.includes("lineageKey not a valid id"), false);
  }
});

test("rejects a v5 config carrying an unknown key", () => {
  const home = makeTemporaryDirectory();
  fs.writeFileSync(
    path.join(home, "recall-journal.json"),
    JSON.stringify({
      version: 5,
      projectMemory: {
        enabled: true,
        defaultProject: {
          workspace: { id: "w", name: "W" },
          recallProject: { id: "p", name: "P" },
        },
        sessions: { enabled: true },
      },
    }),
  );
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: home,
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("rejects a v5 config with no default Project", () => {
  const home = makeTemporaryDirectory();
  fs.writeFileSync(
    path.join(home, "recall-journal.json"),
    JSON.stringify({ version: 5, projectMemory: { enabled: true } }),
  );
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: home,
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "UserPromptSubmit", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});
