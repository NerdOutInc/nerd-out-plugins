import { readSkillGuidanceSync } from "./helpers/read-skill-guidance.mjs";
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
const packagedHookCommand = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, "hooks/hooks.json"), "utf8"),
).hooks.UserPromptSubmit[0].hooks[0].command;
const fixtureRoot = path.join(
  repositoryRoot,
  "tests/fixtures/recall-journal-hook",
);
const GIT_TEST_TIMEOUT_MS = 10_000;
// Claude Code and Codex deliver the protocol once, on their session event;
// every later prompt carries only a short reminder. Tests that read the full
// context therefore run the session event by default.
const sessionStartInput = { hook_event_name: "SessionStart", source: "startup" };
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

// Goldens change only on purpose: UPDATE_RECALL_HOOK_FIXTURES=1 rewrites them
// from the hook's current output before the comparison runs.
function assertFixture(context, version, filename, label) {
  if (process.env.UPDATE_RECALL_HOOK_FIXTURES === "1") {
    fs.writeFileSync(path.join(fixtureRoot, version, filename), `${context}\n`);
  }
  assert.equal(context, readFixture(version, filename), label ?? `${version}/${filename}`);
}

function contextOf(result, label) {
  assert.equal(result.status, 0, label);
  assert.equal(result.stderr, "", label);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
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
  delete environment.CURSOR_HOME;
  delete environment.PLUGIN_ROOT;
  return environment;
}

function runHook({
  args = [],
  cwd,
  environment,
  input = sessionStartInput,
  script = hookScript,
}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: environment,
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
}

function runPackagedHook({
  cwd,
  environment,
  input = sessionStartInput,
}) {
  return spawnSync("/bin/sh", ["-c", packagedHookCommand], {
    cwd,
    encoding: "utf8",
    env: environment,
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
}

// A file that is not any supported version's exact shape is reported, never
// routed: the context names the problem and no destination, tells the agent
// journaling is off until the skill repairs it, and carries no upgrade offer.
function assertInvalidConfigContext(result, label) {
  assert.equal(result.status, 0, label);
  assert.equal(result.stderr, "", label);
  assert.notEqual(result.stdout, "", label);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(
    context,
    /^A recall-journal\.json exists for (?:Codex|Claude Code|Cursor) but is not a valid journal config: /,
    label,
  );
  assert.match(context, /journaling is off until it is repaired/, label);
  assert.match(context, /never rewrite it from this context/, label);
  assert.doesNotMatch(context, /workspaceId |projectUuid |projectId /, label);
  assert.doesNotMatch(context, /This config is version/, label);
  return context;
}

test("uses Cursor's native session hook, config, and stable conversation id", () => {
  const configDirectory = makeConfigDirectory();
  const projectDirectory = makeProjectDirectory("cursor-project");
  const result = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: configDirectory,
    },
    input: {
      hook_event_name: "sessionStart",
      session_id: "cursor-conversation-123",
      workspace_roots: [projectDirectory],
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["additional_context"]);
  assert.match(output.additional_context, /Cursor/);
  assert.match(output.additional_context, /\/recall-journal/);
  assert.match(output.additional_context, /cursor-conversation-123/);
  assert.equal(output.hookSpecificOutput, undefined);
});

test("does not run a per-prompt event through Cursor's native session hook", () => {
  const result = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: makeConfigDirectory(),
    },
    input: { hook_event_name: "beforeSubmitPrompt" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
});

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
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
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

test("the packaged shared hook distinguishes Codex from Claude Code", () => {
  const codexConfigDirectory = makeConfigDirectory();
  const claudeConfigDirectory = makeConfigDirectory();
  const codexResult = runPackagedHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CODEX_HOME: codexConfigDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(codexResult.status, 0);
  assert.equal(codexResult.stderr, "");
  const codexContext = JSON.parse(codexResult.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(codexContext, /Codex/);
  assert.match(codexContext, /\$recall:recall-journal/);
  assert.doesNotMatch(codexContext, /Claude Code/);

  const claudeResult = runPackagedHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(claudeResult.status, 0);
  assert.equal(claudeResult.stderr, "");
  const claudeContext = JSON.parse(claudeResult.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(claudeContext, /Claude Code/);
  assert.match(claudeContext, /\/recall:recall-journal/);
  assert.doesNotMatch(claudeContext, /\$recall:recall-journal/);
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
    assertFixture(context, version, "additional-context.txt");
  }
});

// Every route answers a prompt with a short reminder that names the mode, the
// route, and the lineage, and points back at the session-start context.
test("every prompt carries only a short reminder that points at the session-start context", () => {
  const codex = (configDirectory) => ({
    ...cleanEnvironment(),
    CODEX_HOME: configDirectory,
    PLUGIN_ROOT: pluginRoot,
  });
  const noRepository = makeTemporaryDirectory();
  const savedRoot = makeTemporaryDirectory();
  fs.mkdirSync(path.join(savedRoot, "src"), { recursive: true });
  const cases = [
    ["v1", "reminder.txt", codex(path.join(fixtureRoot, "v1")), repositoryRoot, /^Recall legacy journaling v1 is on for Codex: workspaceId workspace-id; thread id/],
    ["v2", "reminder.txt", codex(path.join(fixtureRoot, "v2")), repositoryRoot, /^Recall legacy journaling v2 is on for Codex: workspaceId /],
    ["v3", "reminder.txt", codex(path.join(fixtureRoot, "v3")), repositoryRoot, /^Recall project memory v3 \(reader-only\) is on for Codex: call resolve_project/],
    ["v4", "repository-reminder.txt", codex(path.join(fixtureRoot, "v4")), repositoryRoot, /^Recall project memory v4 \(reader-only\) is on for Codex: repository-first routing/],
    ["v4", "no-repository-reminder.txt", codex(path.join(fixtureRoot, "v4")), noRepository, /read the configured default workspaceId default-workspace-id and projectUuid default-project-id directly/],
    ["v5", "repository-reminder.txt", codex(path.join(fixtureRoot, "v5")), repositoryRoot, /^Recall project memory v5 is on for Codex: repository-first routing, never the default Project as a recovery path; lineageKey/],
    ["v5", "no-repository-reminder.txt", codex(path.join(fixtureRoot, "v5")), noRepository, /use the default workspaceId default-workspace-id and projectUuid default-project-id \(never resolve_project\)/],
    ["v7", "path-reminder.txt", codex(makeConfigDirectory(v7Config({ paths: { [savedRoot]: v7PathDestination() } }))), path.join(savedRoot, "src"), /the saved destination workspaceId path-workspace-id and projectUuid path-project-id \(never resolve_project\)/],
    ["v7", "repository-with-global-reminder.txt", codex(path.join(fixtureRoot, "v7")), repositoryRoot, /repository-first routing, then the global destination workspaceId global-workspace-id and projectUuid global-project-id/],
    ["v7", "repository-without-global-reminder.txt", codex(makeConfigDirectory(v7Config({ global: null, paths: { [savedRoot]: v7PathDestination() } }))), repositoryRoot, /repository-first routing with no global fallback/],
    ["v7", "no-repository-reminder.txt", codex(path.join(fixtureRoot, "v7")), noRepository, /the global destination workspaceId global-workspace-id and projectUuid global-project-id \(never resolve_project\)/],
    ["v7", "unknown-identity-reminder.txt", codex(path.join(fixtureRoot, "v7")), path.join(noRepository, "missing"), /no destination applies: continue without project memory, open no session/],
  ];
  for (const [version, filename, environment, cwd, expected] of cases) {
    const label = `${version}/${filename}`;
    const context = contextOf(
      runHook({
        environment,
        input: { hook_event_name: "UserPromptSubmit", cwd, session_id: v5ThreadId },
      }),
      label,
    );
    assertFixture(context, version, filename, label);
    assert.match(context, expected, label);
    assert.match(context, /Skip trivial acknowledgements/, label);
    assert.doesNotMatch(context, /This config is version|open_session on the resolved Project/, label);
    assert.ok(Buffer.byteLength(context) <= 400, `${label}: ${Buffer.byteLength(context)} bytes`);
    assert.equal(context.includes(savedRoot), false, label);
    assert.equal(context.includes("\n"), false, label);
  }
});

test("reports an invalid config briefly on every prompt and fully at session start", () => {
  const environment = codexInvalid();
  const session = contextOf(runHook({ environment, input: claudeV5Input }));
  assert.match(session, /^A recall-journal\.json exists for Codex but is not a valid journal config: /);
  assert.match(session, /never rewrite it from this context/);
  const prompt = contextOf(runHook({ environment, input: claudeV5PromptInput }));
  assert.equal(
    prompt,
    "Recall journaling is off for Codex: the saved recall-journal.json is not a valid journal config. Say so once, offer $recall:recall-journal to inspect and repair or replace it with the user's confirmation, and never rewrite it from this context.",
  );
  assert.doesNotMatch(prompt, /This config is version|workspaceId |projectUuid /);

  function codexInvalid() {
    return {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory({ version: 5, projectMemory: { enabled: true } }),
      PLUGIN_ROOT: pluginRoot,
    };
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
  assertFixture(context, "v3", "additional-context.txt");
  assert.match(context, /resolve_project/);
  assert.match(context, /get_project_context/);
  assert.match(context, /structured-memory-only/);
  for (const legacyInstruction of [
    "workspaceId",
    "projectId",
    "create_today_note",
    "exactly one journal note",
    "toggle entries",
    "list_note_activity",
    "read_note",
    "update_note_content",
    "expectedRevision",
  ]) {
    assert.equal(context.includes(legacyInstruction), false, legacyInstruction);
  }
  // The skill is named exactly once, and only to offer the version 7 upgrade;
  // the reader protocol itself still never invites journal setup.
  assert.equal(context.split("$recall:recall-journal").length - 1, 1);
  assert.match(
    context,
    /offer to upgrade it to version 7 through \$recall:recall-journal/,
  );
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
    readFixture("v3", "additional-context.txt")
      .replace("Codex", "Claude Code")
      .replaceAll("$recall:recall-journal", "/recall:recall-journal"),
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

    assertInvalidConfigContext(result, JSON.stringify(config));
  }
});

test("uses repository-first v4 routing without exposing the default Project", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v4"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assertFixture(context, "v4", "repository-context.txt");
  assert.match(context, /repository-first routing/);
  assert.match(context, /resolve_project/);
  assert.match(context, /get_project_context/);
  assert.match(context, /none, ambiguous, or not_ready/);
  assert.match(
    context,
    /Lifecycle context never writes, migrates, or downgrades/,
  );
  assert.match(
    context,
    /explicit upgrade runs only through the recall-journal skill/,
  );
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: noRepository },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assertFixture(context, "v4", "no-repository-context.txt");
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: repository },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assertFixture(context, "v4", "repository-context.txt");
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: missingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
  });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.equal(
    context,
    readFixture("v4", "repository-context.txt")
      .replace("Codex", "Claude Code")
      .replaceAll("$recall:recall-journal", "/recall:recall-journal"),
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
      input: { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
    });

    assertInvalidConfigContext(result, JSON.stringify(config));
  }
});

test("keeps v3/v4 reader-only while gating explicit v5 setup", () => {
  const [skill, configuration] = [
    "plugins/recall/skills/recall-journal/SKILL.md",
    "plugins/recall/skills/recall-journal/references/configuration.md",
  ].map((relativePath) =>
    relativePath.endsWith("/SKILL.md")
      ? readSkillGuidanceSync(path.join(repositoryRoot, relativePath))
      : fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
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
  assert.match(configuration, /"version": 5/);
  assert.match(
    configuration,
    /Offer \*\*Structured Project activity\*\* only when all of these are\s+advertised/,
  );
  assert.match(configuration, /Never auto-migrate a version 1 or 2 config/);
  assert.match(configuration, /cannot be translated\s+losslessly/);
  assert.match(configuration, /Re-check\s+the whole gate immediately before/);
  assert.match(
    configuration,
    /Cursor: `\$CURSOR_HOME`, falling back to `~\/\.cursor`/,
  );
  assert.match(
    configuration,
    /For Legacy journal note, also\s+confirm the scope, absolute filesystem path when applicable, workspace,\s+optional Recall Project, and summary target/,
  );
  assert.match(configuration, /When keeping Legacy journal-note mode/);
  assert.match(configuration, /When keeping version 5/);
  assert.match(
    configuration,
    /never add legacy routing fields,\s+ask about a summary target, or use a workspace root/,
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
    input: { hook_event_name: "SessionStart", source: "startup", session_id: "thread-123" },
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

    assertInvalidConfigContext(result, JSON.stringify(journal));
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
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
      hook_event_name: "SessionStart", source: "startup",
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
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
      input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
    });
    assertInvalidConfigContext(result, JSON.stringify(config));
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
      hook_event_name: "SessionStart", source: "startup",
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
    input: { hook_event_name: "SessionStart", source: "startup", thread_id: "thread-123" },
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
      input: { hook_event_name: "SessionStart", source: "startup", session_id: sessionId },
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

test("reports an invalid config when the workspace id is not a plain token", () => {
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

    assertInvalidConfigContext(result, `invalid workspace id ${JSON.stringify(id)}`);
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

test("reports a file that is not a valid journal config instead of staying silent", () => {
  const oversized = v7Config({
    paths: Object.fromEntries(
      Array.from({ length: 700 }, (_, index) => [
        `/Users/example/projects/${"x".repeat(60)}-${index}`,
        v7PathDestination(),
      ]),
    ),
  });
  for (const [config, description] of [
    [{ version: 1 }, /its contents do not match the exact version 1 shape/],
    ["not json", /it is not valid JSON/],
    [
      { version: 8, projectMemory: { enabled: true } },
      /its version 8 is newer than this plugin supports/,
    ],
    [{}, /its version field is missing/],
    [
      { version: 6, projectMemory: { enabled: true } },
      /do not match the exact version 6 shape/,
    ],
    [oversized, /larger than the 64 KiB bound/],
  ]) {
    const directory = makeTemporaryDirectory();
    const text = typeof config === "string" ? config : JSON.stringify(config);
    fs.writeFileSync(path.join(directory, "recall-journal.json"), text);
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: directory,
        PLUGIN_ROOT: pluginRoot,
      },
    });
    const label = text.slice(0, 80);
    const context = assertInvalidConfigContext(result, label);
    assert.match(context, description, label);
    assert.match(
      context,
      /\$recall:recall-journal can inspect it and repair or replace it/,
      label,
    );
    // Reported, never repaired: the file and its directory are untouched.
    assert.equal(
      fs.readFileSync(path.join(directory, "recall-journal.json"), "utf8"),
      text,
      label,
    );
    assert.deepEqual(fs.readdirSync(directory), ["recall-journal.json"], label);
  }

  // Cursor gets the same report in its own hook shape.
  const cursor = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: makeConfigDirectory({ version: 1 }),
    },
    input: { hook_event_name: "sessionStart", session_id: "cursor-1" },
  });
  assert.equal(cursor.status, 0, cursor.stderr);
  const cursorContext = JSON.parse(cursor.stdout).additional_context;
  assert.match(
    cursorContext,
    /^A recall-journal\.json exists for Cursor but is not a valid journal config/,
  );
  assert.match(cursorContext, /\/recall-journal can inspect it/);

  // Other events stay silent even when the file is invalid.
  const otherEvent = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory({ version: 1 }),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "PreToolUse" },
  });
  assert.equal(otherEvent.status, 0);
  assert.equal(otherEvent.stdout, "");
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

test("ignores hook events other than SessionStart and UserPromptSubmit", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(),
      PLUGIN_ROOT: pluginRoot,
    },
    input: { hook_event_name: "Stop" },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: nestedDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: workingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: workingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: unrelatedDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: nestedDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: siblingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: workingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: workingDirectory },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: "nested" },
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: dottedDirectory },
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

test("reports an invalid config when the projects map is malformed", () => {
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
      input: { hook_event_name: "SessionStart", source: "startup", cwd: absoluteRoot },
    });

    assertInvalidConfigContext(
      result,
      `invalid projects ${JSON.stringify(projects)}`,
    );
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: projectRoot },
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
      hook_event_name: "SessionStart", source: "startup",
      cwd: repositoryRoot,
      session_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assertFixture(context, "v5", "repository-context.txt");
  assert.match(context, /repository-first routing/);
  assert.match(context, /none, ambiguous, or not_ready/);
  assert.match(context, /as remoteUrl/);
  assert.match(context, /as repoRootBasename/);
  assert.match(context, /fix the parameters .* and retry once/);
  assert.match(
    context,
    /first user-visible reply instead of degrading silently/,
  );
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
      hook_event_name: "SessionStart", source: "startup",
      cwd: noRepository,
      session_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assertFixture(context, "v5", "no-repository-context.txt");
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
      hook_event_name: "SessionStart", source: "startup",
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
  // No tool is called on this route, so the malformed-call retry rule that
  // qualifies the other two routes' give-up lists must not appear here.
  assert.equal(context.includes("retry once"), false);
});

test("v5 names the session tools and never the retired card recipe", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: "SessionStart", source: "startup",
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
  assert.match(context, /Today -> Now activity/);
  assert.match(context, /concise plain-language intent/);
  assert.match(context, /the exact current branch when one exists/);
  assert.match(context, /useful title/);
  assert.match(context, /decision, blocker, shipped, or progress/);
  assert.match(context, /always this sessionUuid/);
  assert.match(context, /60 to 120 words of text/);
  assert.match(context, /profile journal, noteLimit 2, and entryLimit 6/);
  assert.match(context, /read_entry or read_session, when advertised, only when that row matters to the task/);
  assert.match(context, /Verify through tool discovery that those tools are callable here/);
  assert.match(
    context,
    /Load \$recall:recall-journal for efforts, failed or uncertain writes, configuration, upgrade, or repair, or the full protocol/,
  );
  assert.match(context, /handful of durable checkpoints/);
  assert.match(context, /rejoin Today's chronology after close/);
  assert.match(context, /open_session\.effortUuid/);
  assert.match(context, /including record_milestone\.todayCard/);
  assert.match(context, /recording milestones with record_milestone/);
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
      hook_event_name: "SessionStart", source: "startup",
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
    { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
    {
      hook_event_name: "SessionStart", source: "startup",
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
  });

  assert.match(
    assertInvalidConfigContext(result, "invalid v5"),
    /exact version 5 shape/,
  );
});

// Fabricates the process table the hook's bridge detection walks: a Claude
// host (pid 500) with one unrelated plugin server, optionally a bridge child,
// and the hook itself. $PPID inside the fake ps expands to the pid of the
// process that spawned it — the hook — so the walk starts from a real row.
function makeFakePsDirectory({
  bridgeCommand = null,
  hostCommand = "/Users/x/Library/Application Support/Claude/claude-code/2.1.246/claude.app/Contents/MacOS/claude --output-format stream-json",
  markerPath = null,
} = {}) {
  const directory = makeTemporaryDirectory();
  const script = [
    "#!/bin/sh",
    markerPath ? `printf . >> ${JSON.stringify(markerPath)}` : ":",
    `echo "  500 1 ${hostCommand}"`,
    'echo "  501 500 node /plugins/other-plugin/server.mjs"',
    bridgeCommand ? `echo "  502 500 ${bridgeCommand}"` : ":",
    'echo "  $PPID 500 node /plugins/recall/hooks/journal-context.mjs"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(directory, "ps"), script, { mode: 0o755 });
  return directory;
}

function claudeV5Environment({ psDirectory, temporaryDirectory }) {
  return {
    ...cleanEnvironment(),
    CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v5"),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    PATH: psDirectory,
    TMPDIR: temporaryDirectory,
  };
}

const claudeV5Input = {
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: repositoryRoot,
  session_id: v5ThreadId,
};
const claudeV5PromptInput = {
  hook_event_name: "UserPromptSubmit",
  cwd: repositoryRoot,
  session_id: v5ThreadId,
};

// The goldens use the Codex host; Claude Code differs only in its names.
function claudeAdjustedV5Fixture(filename) {
  return readFixture("v5", filename)
    .replace("Codex", "Claude Code")
    .replaceAll("$recall:recall-journal", "/recall:recall-journal")
    .replaceAll("$recall:doctor", "/recall:doctor");
}

test("v5 reports an absent connector briefly on every prompt instead of the protocol", () => {
  const result = runHook({
    environment: claudeV5Environment({
      psDirectory: makeFakePsDirectory(),
      temporaryDirectory: makeTemporaryDirectory(),
    }),
    input: claudeV5PromptInput,
  });

  const context = contextOf(result);
  assertFixture(context, "v5", "bridge-missing-reminder.txt");
  assert.match(context, /no Recall bridge child/);
  assert.match(context, /advisory hint, not tool availability/);
  assert.match(context, /resolve_project and open_session/);
  assert.match(context, /journaling is unavailable/);
  assert.match(context, /do not keep searching/);
  assert.match(context, /\/recall:doctor/);
  assert.match(context, /never create a legacy journal note/);
  // The protocol is never recited here, and nothing invites a session.
  assert.equal(context.includes("lineageKey"), false);
  assert.equal(context.includes("close_session"), false);
  assert.ok(Buffer.byteLength(context) <= 640, String(Buffer.byteLength(context)));
});

test("v5 keeps the short per-prompt reminder when the session bridge is present", () => {
  for (const bridgeCommand of [
    "node /Users/x/plugins/recall/bridge/index.mjs --client-name Claude",
    "/Applications/Recall.app/Contents/Helpers/recall-mcp-bridge --client-name Claude",
  ]) {
    const result = runHook({
      environment: claudeV5Environment({
        psDirectory: makeFakePsDirectory({ bridgeCommand }),
        temporaryDirectory: makeTemporaryDirectory(),
      }),
      input: claudeV5PromptInput,
    });

    assert.equal(
      contextOf(result, bridgeCommand),
      claudeAdjustedV5Fixture("repository-reminder.txt"),
      bridgeCommand,
    );
  }
});

test("v5 keeps the short per-prompt reminder when detection cannot decide", () => {
  // An unrecognized host process and a missing ps are both "unknown", and
  // unknown never changes what the agent is told.
  const environments = [
    claudeV5Environment({
      psDirectory: makeFakePsDirectory({
        hostCommand: "node /repo/tests/run-everything.mjs",
      }),
      temporaryDirectory: makeTemporaryDirectory(),
    }),
    claudeV5Environment({
      psDirectory: makeTemporaryDirectory(),
      temporaryDirectory: makeTemporaryDirectory(),
    }),
  ];

  for (const environment of environments) {
    const result = runHook({ environment, input: claudeV5PromptInput });
    assert.equal(
      contextOf(result),
      claudeAdjustedV5Fixture("repository-reminder.txt"),
    );
  }
});

test("v5 session start never runs connector detection and carries the verification rule instead", () => {
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const result = runHook({
    environment: claudeV5Environment({
      psDirectory: makeFakePsDirectory({ markerPath }),
      temporaryDirectory: makeTemporaryDirectory(),
    }),
    input: claudeV5Input,
  });

  const context = contextOf(result);
  assert.equal(context, claudeAdjustedV5Fixture("repository-context.txt"));
  assert.match(
    context,
    /Verify through tool discovery that those tools are callable here; a loaded hook or skill is not proof/,
  );
  assert.doesNotMatch(
    context,
    /no Recall bridge child|connector presence is unknown/,
  );
  // At session start the bridge may not exist yet, so no snapshot is taken.
  assert.equal(fs.existsSync(markerPath), false);
});

test("v5 session start after a resume or compaction adds the session recovery rule", () => {
  for (const source of ["resume", "compact"]) {
    const context = contextOf(
      runHook({
        environment: {
          ...cleanEnvironment(),
          CODEX_HOME: path.join(fixtureRoot, "v5"),
          PLUGIN_ROOT: pluginRoot,
        },
        input: { ...claudeV5Input, source },
      }),
      source,
    );
    assert.match(context, /do not open a second session/, source);
    assert.match(context, /recover it with list_sessions/, source);
    assert.match(context, /Version 5 is the structured writer/, source);
    assert.ok(Buffer.byteLength(context) <= 4608, source);
  }
  for (const source of ["startup", "clear", "fork"]) {
    const context = contextOf(
      runHook({
        environment: {
          ...cleanEnvironment(),
          CODEX_HOME: path.join(fixtureRoot, "v5"),
          PLUGIN_ROOT: pluginRoot,
        },
        input: { ...claudeV5Input, source },
      }),
      source,
    );
    assert.doesNotMatch(context, /second session|list_sessions/, source);
    assert.ok(Buffer.byteLength(context) <= 4352, source);
  }
});

test("v5 checks Codex with its requested host on every prompt", () => {
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: path.join(fixtureRoot, "v5"),
      PLUGIN_ROOT: pluginRoot,
      PATH: makeFakePsDirectory({
        markerPath,
        hostCommand: "codex app-server",
      }),
    },
    input: claudeV5PromptInput,
  });

  const context = contextOf(result);
  assertFixture(context, "v5", "repository-reminder.txt");
  assert.doesNotMatch(context, /no Recall bridge child/);
  assert.equal(fs.readFileSync(markerPath, "utf8"), ".");
});

test("v5 checks a previously present bridge again on every prompt", () => {
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const environment = claudeV5Environment({
    psDirectory: makeFakePsDirectory({
      bridgeCommand:
        "node /Users/x/plugins/recall/bridge/index.mjs --client-name Claude",
      markerPath,
    }),
    temporaryDirectory: makeTemporaryDirectory(),
  });

  runHook({ environment, input: claudeV5PromptInput });
  const second = runHook({ environment, input: claudeV5PromptInput });

  assert.equal(
    contextOf(second),
    claudeAdjustedV5Fixture("repository-reminder.txt"),
  );
  assert.equal(fs.readFileSync(markerPath, "utf8"), "..");
});

test("v5 re-checks an absent bridge on every prompt", () => {
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const environment = claudeV5Environment({
    psDirectory: makeFakePsDirectory({ markerPath }),
    temporaryDirectory: makeTemporaryDirectory(),
  });

  runHook({ environment, input: claudeV5PromptInput });
  const second = runHook({ environment, input: claudeV5PromptInput });

  assert.equal(
    contextOf(second),
    readFixture("v5", "bridge-missing-reminder.txt"),
  );
  assert.equal(fs.readFileSync(markerPath, "utf8"), "..");
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
    input: { hook_event_name: "SessionStart", source: "startup", cwd: repositoryRoot },
  });

  assert.match(
    assertInvalidConfigContext(result, "invalid v5"),
    /exact version 5 shape/,
  );
});

test("v5 Cursor checks shared and unverified hosts without adopting a neighboring bridge", () => {
  for (const hostCommand of [
    "/Applications/Cursor.app/Contents/MacOS/Cursor",
    "/Users/x/.local/share/cursor-agent/versions/example/cursor-agent",
    "/Users/x/.grok/bin/agent",
  ]) {
    const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
    const result = runHook({
      args: ["--host", "cursor"],
      environment: {
        ...cleanEnvironment(),
        CURSOR_HOME: path.join(fixtureRoot, "v5"),
        PATH: makeFakePsDirectory({
          hostCommand,
          bridgeCommand:
            "node /plugins/recall/bridge/index.mjs --client-name Cursor",
          markerPath,
        }),
      },
      input: {
        hook_event_name: "sessionStart",
        workspace_roots: [repositoryRoot],
        conversation_id: v5ThreadId,
      },
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput, undefined);
    assert.match(output.additional_context, /enabled for Cursor/);
    assert.match(
      output.additional_context,
      /Current-session Recall connector presence is unknown/,
    );
    assert.match(
      output.additional_context,
      /Verify the current conversation's tools/,
    );
    assert.match(output.additional_context, /Load \/recall-journal/);
    assert.doesNotMatch(
      output.additional_context,
      /no Recall bridge child|connector simply started late/,
    );
    assert.equal(fs.readFileSync(markerPath, "utf8"), ".");
  }
});

test("v5 Codex and Cursor never adopt a Claude process as their own host", () => {
  for (const host of ["codex", "cursor"]) {
    const result = runHook({
      args: ["--host", host],
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: path.join(fixtureRoot, "v5"),
        CURSOR_HOME: path.join(fixtureRoot, "v5"),
        PATH: makeFakePsDirectory(),
      },
      input: {
        hook_event_name:
          host === "cursor" ? "sessionStart" : "UserPromptSubmit",
        cwd: repositoryRoot,
        session_id: v5ThreadId,
      },
    });
    const output = JSON.parse(result.stdout);
    if (host === "cursor") {
      assert.match(
        output.additional_context,
        /Current-session Recall connector presence is unknown/,
      );
      assert.doesNotMatch(output.additional_context, /no Recall bridge child/);
    } else {
      const context = output.hookSpecificOutput.additionalContext;
      assert.match(context, /^Recall project memory v5 is on for Codex/);
      assert.doesNotMatch(context, /no Recall bridge child/);
    }
  }
});

test("v5 notices a previously present connector exiting despite an old cache file", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const first = runHook({
    environment: claudeV5Environment({
      psDirectory: makeFakePsDirectory({
        markerPath,
        bridgeCommand:
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
      }),
      temporaryDirectory,
    }),
    input: claudeV5PromptInput,
  });
  assert.match(
    JSON.parse(first.stdout).hookSpecificOutput.additionalContext,
    /^Recall project memory v5 is on for Claude Code/,
  );
  const cachePath = path.join(
    temporaryDirectory,
    "recall-bridge-status-" + v5ThreadId + ".json",
  );
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ status: "present", hostPid: 500, bridgePid: 502 }),
  );
  const second = runHook({
    environment: claudeV5Environment({
      psDirectory: makeFakePsDirectory({ markerPath }),
      temporaryDirectory,
    }),
    input: claudeV5PromptInput,
  });
  assert.equal(
    JSON.parse(second.stdout).hookSpecificOutput.additionalContext,
    readFixture("v5", "bridge-missing-reminder.txt"),
  );
  assert.equal(fs.readFileSync(markerPath, "utf8"), "..");
  assert.deepEqual(fs.readdirSync(temporaryDirectory), [
    path.basename(cachePath),
  ]);
});

test("v1 through v4 do not run connector detection or alter their legacy contracts", () => {
  for (const version of [1, 2, 3, 4]) {
    const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v" + version),
        PATH: makeFakePsDirectory({ markerPath }),
      },
      input: claudeV5PromptInput,
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.trim());
    assert.equal(fs.existsSync(markerPath), false);
  }
});

function v6ConfigDirectory() {
  return makeConfigDirectory({
    version: 6,
    projectMemory: {
      enabled: true,
      defaultProject: {
        workspace: { id: "test-workspace", name: "Workspace" },
        recallProject: { id: "test-project", name: "Project" },
      },
    },
    sessionLifecycle: { enabled: true },
  });
}

test("v6 missing and unknown connector hints preserve adapter status and no-downgrade rules", () => {
  for (const [host, hostCommand, bridgeCommand, hint] of [
    ["claude-code", "claude", null, /no Recall bridge child/],
    ["codex", "codex app-server", null, /connector presence is unknown/],
    [
      "codex",
      "codex app-server",
      "node /plugins/recall/bridge/index.mjs --client-name Codex",
      /connector presence is unknown/,
    ],
    ["codex", "codex exec --json", null, /connector presence is unknown/],
  ]) {
    const directory = v6ConfigDirectory();
    const originalConfig = fs.readFileSync(
      path.join(directory, "recall-journal.json"),
      "utf8",
    );
    const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
    const result = runHook({
      args: ["--host", host],
      environment: {
        ...cleanEnvironment(),
        CLAUDE_CONFIG_DIR: directory,
        CODEX_HOME: directory,
        PATH: makeFakePsDirectory({ hostCommand, bridgeCommand, markerPath }),
      },
      input: { ...claudeV5PromptInput, agent_id: "test-participant" },
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(context, /opt-in version 6 conversation-segment adapter/);
    assert.match(context, hint);
    assert.match(
      context,
      /Check whether begin_session_recording and get_session_recording_status are callable/,
    );
    assert.match(
      context,
      /Only an authoritative adapter result with a supported participant identity/,
    );
    assert.match(
      context,
      /Never downgrade version 6, call open_session, or create a legacy journal as a fallback/,
    );
    assert.match(context, /doctor/);
    assert.doesNotMatch(
      context,
      /journal normally under version 5|Version 5 is the structured writer/,
    );
    assert.equal(fs.readFileSync(markerPath, "utf8"), ".");
    assert.equal(
      fs.readFileSync(path.join(directory, "recall-journal.json"), "utf8"),
      originalConfig,
    );
    assert.deepEqual(fs.readdirSync(directory), ["recall-journal.json"]);
  }
});

test("v6 unsupported participant and Cursor remain unavailable rather than opening a v5 session", () => {
  const directory = v6ConfigDirectory();
  const result = runHook({
    args: ["--host", "codex"],
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: directory,
      PATH: makeFakePsDirectory({ hostCommand: "codex app-server" }),
    },
    input: { ...claudeV5PromptInput, agent_id: "bad identity" },
  });
  const context = JSON.parse(result.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /does not establish a supported participant identity/);
  assert.match(context, /Never substitute the parent or guess main/);
  assert.match(context, /connector presence is unknown/);
  assert.doesNotMatch(context, /Local tool identity:/);

  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const cursor = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: directory,
      PATH: makeFakePsDirectory({
        hostCommand: "/Applications/Cursor.app/Contents/MacOS/Cursor",
        markerPath,
      }),
    },
    input: { hook_event_name: "sessionStart", conversation_id: v5ThreadId },
  });
  assert.equal(cursor.status, 0);
  assert.equal(cursor.stdout, "");
  assert.equal(fs.existsSync(markerPath), false);
});

// Version 7 restores global and per-path destinations to the structured
// writer. Its fixtures use the Codex host, so each golden text ends with the
// unknown-connector suffix exactly as the version 5 fixtures do.

function v7GlobalDestination() {
  return {
    workspace: { id: "global-workspace-id", name: "General Memory" },
    recallProject: { id: "global-project-id", name: "General" },
  };
}

function v7PathDestination() {
  return {
    workspace: { id: "path-workspace-id", name: "Product Team" },
    recallProject: { id: "path-project-id", name: "Bound App" },
  };
}

function v7Config({
  global = v7GlobalDestination(),
  paths,
  sessionLifecycle,
} = {}) {
  const projectMemory = { enabled: true };
  if (global) projectMemory.global = global;
  if (paths) projectMemory.paths = paths;
  const config = { version: 7, projectMemory };
  if (sessionLifecycle) config.sessionLifecycle = sessionLifecycle;
  return config;
}

function runV7Hook(configDirectory, cwd, eventName = "SessionStart") {
  return runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: configDirectory,
      PLUGIN_ROOT: pluginRoot,
    },
    input: {
      hook_event_name: eventName,
      ...(eventName === "SessionStart" ? { source: "startup" } : {}),
      cwd,
      session_id: v5ThreadId,
    },
  });
}

function v7Context(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function makeRepositoryWithBoundRemote() {
  const root = makeTemporaryDirectory();
  runGit(root, "init", "--quiet");
  runGit(root, "remote", "add", "origin", "git@github.com:example/app.git");
  const nested = path.join(root, "src", "app");
  fs.mkdirSync(nested, { recursive: true });
  return { nested, root };
}

function assertNoV7Leak(context, ...paths) {
  for (const directory of paths) {
    assert.equal(context.includes(directory), false, directory);
  }
  assert.equal(context.includes("/Users/example"), false);
}

test("v7 routes a saved filesystem-project destination without printing its path", () => {
  const savedRoot = makeTemporaryDirectory();
  const nested = path.join(savedRoot, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  const context = v7Context(
    runV7Hook(
      makeConfigDirectory(
        v7Config({ paths: { [savedRoot]: v7PathDestination() } }),
      ),
      nested,
    ),
  );

  assertFixture(context, "v7", "path-context.txt");
  assert.match(context, /version 7 is enabled for Codex/);
  assert.match(context, /saved filesystem-project destination covers/);
  assert.match(context, /projectUuid path-project-id/);
  assert.match(context, /workspaceId path-workspace-id/);
  assert.match(context, /Do not call resolve_project or fabricate/);
  assert.match(context, /do not choose the global destination/);
  assert.match(context, /retry once/);
  assert.match(context, /Version 7 is the structured writer/);
  assert.match(context, new RegExp(`lineageKey ${v5ThreadId}`));
  assert.doesNotMatch(context, /repository-first|remoteUrl|takes precedence/);
  assert.equal(context.includes("global-project-id"), false);
  assert.equal(context.includes("General Memory"), false);
  assertNoV7Leak(context, savedRoot);
});

test("v7 path destination wins inside a repository with a bound remote", () => {
  const { nested, root } = makeRepositoryWithBoundRemote();
  const context = v7Context(
    runV7Hook(
      makeConfigDirectory(v7Config({ paths: { [root]: v7PathDestination() } })),
      nested,
    ),
  );

  assertFixture(context, "v7", "path-in-repository-context.txt");
  assert.match(
    context,
    /takes precedence over this repository's Git remote binding: do not call resolve_project here/,
  );
  assert.match(context, /projectUuid path-project-id/);
  assert.doesNotMatch(context, /repository-first|remoteUrl|repoRootBasename/);
  assert.equal(context.includes("global-project-id"), false);
  assertNoV7Leak(context, root);
});

test("v7 maps a linked worktree back to its saved main checkout", () => {
  const { linkedWorktree, mainCheckout, nestedProject } =
    makeRepositoryWithLinkedWorktree();
  const workingDirectory = path.join(linkedWorktree, "packages", "app");

  for (const savedRoot of [mainCheckout, nestedProject]) {
    const context = v7Context(
      runV7Hook(
        makeConfigDirectory(
          v7Config({ paths: { [savedRoot]: v7PathDestination() } }),
        ),
        workingDirectory,
      ),
    );
    assertFixture(
      context,
      "v7",
      "path-in-linked-worktree-context.txt",
      savedRoot,
    );
    // A linked worktree is a repository, so the path-bound paragraph reads
    // exactly as it does inside the main checkout.
    assert.equal(
      context,
      readFixture("v7", "path-in-repository-context.txt"),
      savedRoot,
    );
    assertNoV7Leak(context, linkedWorktree, mainCheckout);
  }
});

test("v7 uses repository-first routing and names the global fallback", () => {
  const context = v7Context(
    runV7Hook(path.join(fixtureRoot, "v7"), repositoryRoot),
  );

  assertFixture(context, "v7", "repository-with-global-context.txt");
  assert.match(context, /No saved filesystem-project destination covers/);
  assert.match(context, /repository-first routing/);
  assert.match(context, /as remoteUrl/);
  assert.match(context, /as repoRootBasename/);
  assert.match(context, /Only an exact match may feed get_project_context/);
  assert.match(
    context,
    /no supported remote, or resolution returns none, ambiguous, or not_ready, fall back to the global Recall workspace "General Memory" \(workspaceId global-workspace-id\) and Recall Project "General" \(projectId global-project-id\)/,
  );
  assert.match(context, /projectUuid global-project-id/);
  assert.match(context, /do not choose another Project/);
  assert.match(context, /retry once/);
  // The version 5 refusal is gone: an unbound repository now has a home.
  assert.doesNotMatch(
    context,
    /never use the default Project as a recovery path/,
  );
  assert.doesNotMatch(context, /do not use the configured default Project/);
  assert.equal(context.includes("path-project-id"), false);
  assert.equal(context.includes("Bound App"), false);
  assertNoV7Leak(context, repositoryRoot);
});

test("v7 repository routing has no fallback without a global destination", () => {
  const context = v7Context(
    runV7Hook(
      makeConfigDirectory(
        v7Config({
          global: null,
          paths: { "/Users/example/projects/bound-app": v7PathDestination() },
        }),
      ),
      repositoryRoot,
    ),
  );

  assertFixture(context, "v7", "repository-without-global-context.txt");
  assert.match(context, /repository-first routing/);
  assert.match(
    context,
    /No global destination is configured, so if there is no supported remote, resolve_project or the session tools are unavailable, or resolution returns none, ambiguous, or not_ready, continue without project memory/,
  );
  assert.doesNotMatch(context, /fall back/);
  assert.equal(context.includes("path-project-id"), false);
  assert.equal(context.includes("global-project-id"), false);
  assertNoV7Leak(context, repositoryRoot);
});

test("v7 uses the global destination when no repository identity exists", () => {
  const noRepository = makeTemporaryDirectory();
  const context = v7Context(
    runV7Hook(path.join(fixtureRoot, "v7"), noRepository),
  );

  assertFixture(context, "v7", "no-repository-context.txt");
  assert.match(
    context,
    /no filesystem repository identity was found, so use the global Recall workspace "General Memory"/,
  );
  assert.match(context, /projectUuid global-project-id/);
  assert.match(context, /Do not call resolve_project or fabricate/);
  assert.match(context, /retry once/);
  assert.doesNotMatch(context, /proved no-repository route/);
  assert.equal(context.includes("path-project-id"), false);
  assertNoV7Leak(context, noRepository);
});

test("v7 withholds every destination when repository identity cannot be proved", () => {
  const missingDirectory = path.join(
    makeTemporaryDirectory(),
    "missing-working-directory",
  );
  const context = v7Context(
    runV7Hook(path.join(fixtureRoot, "v7"), missingDirectory),
  );

  assertFixture(context, "v7", "unknown-identity-context.txt");
  assert.match(
    context,
    /could not prove whether this working directory has filesystem repository identity/,
  );
  assert.match(
    context,
    /do not use a saved filesystem-project or global destination, and do not open a session/,
  );
  assert.match(
    context,
    /Say plainly in your first user-visible reply that structured journaling is unavailable/,
  );
  assert.equal(context.includes("global-project-id"), false);
  assert.equal(context.includes("path-project-id"), false);
  assert.equal(context.includes("General Memory"), false);
  // No Project was resolved, so nothing that follows one may appear: not the
  // writer protocol, not the lineage key, not the skill, and not the
  // malformed-call retry rule that qualifies the tool-using routes.
  for (const absent of [
    "structured writer",
    "open_session",
    "append_entry",
    "close_session",
    "lineageKey",
    "recall-journal",
    "retry once",
    "connector presence",
  ]) {
    assert.equal(context.includes(absent), false, absent);
  }
});

test("v7 stays silent outside every saved path without a global destination", () => {
  const result = runV7Hook(
    makeConfigDirectory(
      v7Config({
        global: null,
        paths: { "/Users/example/projects/bound-app": v7PathDestination() },
      }),
    ),
    makeTemporaryDirectory(),
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
});

test("v7 prefers the longest matching saved root when saved paths nest", () => {
  const outerRoot = makeTemporaryDirectory();
  const innerRoot = path.join(outerRoot, "packages", "app");
  const innerWorkingDirectory = path.join(innerRoot, "src");
  const outerWorkingDirectory = path.join(outerRoot, "docs");
  fs.mkdirSync(innerWorkingDirectory, { recursive: true });
  fs.mkdirSync(outerWorkingDirectory, { recursive: true });
  const configDirectory = makeConfigDirectory(
    v7Config({
      paths: {
        [outerRoot]: v7PathDestination(),
        [innerRoot]: {
          workspace: { id: "inner-workspace-id", name: "Inner" },
          recallProject: { id: "inner-project-id", name: "Inner App" },
        },
      },
    }),
  );

  const inner = v7Context(runV7Hook(configDirectory, innerWorkingDirectory));
  assert.match(inner, /projectUuid inner-project-id/);
  assert.equal(inner.includes("path-project-id"), false);

  const outer = v7Context(runV7Hook(configDirectory, outerWorkingDirectory));
  assert.match(outer, /projectUuid path-project-id/);
  assert.equal(outer.includes("inner-project-id"), false);
  assertNoV7Leak(inner, outerRoot);
  assertNoV7Leak(outer, outerRoot);
});

test("rejects malformed v7 configs instead of choosing a routing protocol", () => {
  const workspaceOnly = { workspace: { id: "w", name: "W" } };
  const configs = [
    { version: 7, projectMemory: { enabled: true } },
    { version: 7, projectMemory: { enabled: true, paths: {} } },
    {
      version: 7,
      projectMemory: { enabled: false, global: v7GlobalDestination() },
    },
    {
      version: 7,
      projectMemory: { enabled: true, defaultProject: v7GlobalDestination() },
    },
    { ...v7Config(), global: v7GlobalDestination() },
    { ...v7Config(), projects: {} },
    { ...v7Config(), journal: { summaryTarget: "none", dailyNote: false } },
    v7Config({ global: workspaceOnly }),
    v7Config({ global: { ...v7GlobalDestination(), recallProject: null } }),
    v7Config({ paths: { [repositoryRoot]: workspaceOnly } }),
    v7Config({ paths: { "relative/path": v7PathDestination() } }),
    v7Config({ paths: { "/": v7PathDestination() } }),
    v7Config({ paths: [] }),
    v7Config({ paths: { [repositoryRoot]: null } }),
    v7Config({
      global: { ...v7GlobalDestination(), extra: true },
    }),
    v7Config({ sessionLifecycle: { enabled: "yes" } }),
    v7Config({ sessionLifecycle: { enabled: true, extra: true } }),
    v7Config({
      sessionLifecycle: { enabled: false, codexParticipantVerified: "no" },
    }),
    { ...v7Config(), sessionLifecycle: null },
    { ...v7Config(), sessionLifecycle: {} },
  ];

  for (const config of configs) {
    const result = runV7Hook(makeConfigDirectory(config), repositoryRoot);
    assertInvalidConfigContext(result, JSON.stringify(config));
  }
});

test("v7 with the session-recording pilot enabled yields to the version 6 adapter context", () => {
  for (const [enabled, input, expected, forbidden] of [
    [
      true,
      claudeV5PromptInput,
      /opt-in version 6 conversation-segment adapter/,
      /Version 7 is the structured writer|version 7 is enabled|record_milestone\.todayCard|Recall project memory v7/,
    ],
    [
      false,
      claudeV5Input,
      /Version 7 is the structured writer/,
      /version 6|begin_session_recording/,
    ],
    [
      false,
      claudeV5PromptInput,
      /^Recall project memory v7 is on for Claude Code/,
      /version 6|begin_session_recording|Version 7 is the structured writer/,
    ],
  ]) {
    const directory = makeConfigDirectory(
      v7Config({ sessionLifecycle: { enabled } }),
    );
    const originalConfig = fs.readFileSync(
      path.join(directory, "recall-journal.json"),
      "utf8",
    );
    const result = runHook({
      args: ["--host", "claude-code"],
      environment: {
        ...cleanEnvironment(),
        CLAUDE_CONFIG_DIR: directory,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PATH: makeFakePsDirectory({
          bridgeCommand:
            "node /plugins/recall/bridge/index.mjs --client-name Claude",
        }),
        TMPDIR: makeTemporaryDirectory(),
      },
      input,
    });

    assert.equal(result.status, 0, String(enabled));
    assert.equal(result.stderr, "", String(enabled));
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(context, expected, String(enabled));
    assert.doesNotMatch(context, forbidden, String(enabled));
    assert.equal(
      fs.readFileSync(path.join(directory, "recall-journal.json"), "utf8"),
      originalConfig,
    );
    assert.deepEqual(fs.readdirSync(directory), ["recall-journal.json"]);
  }
});

function claudeAdjustedV7Fixture(filename) {
  return readFixture("v7", filename)
    .replace("Codex", "Claude Code")
    .replaceAll("$recall:recall-journal", "/recall:recall-journal")
    .replaceAll("$recall:doctor", "/recall:doctor");
}

test("v7 reports an absent connector briefly on every prompt instead of the protocol", () => {
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v7"),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: makeFakePsDirectory(),
      TMPDIR: makeTemporaryDirectory(),
    },
    input: claudeV5PromptInput,
  });

  const context = contextOf(result);
  assertFixture(context, "v7", "bridge-missing-reminder.txt");
  assert.match(context, /^Recall project memory v7 is on for Claude Code, but/);
  assert.match(context, /no Recall bridge child/);
  assert.doesNotMatch(context, /v5\b|version 5/);
  assert.equal(context.includes("lineageKey"), false);
  assert.equal(context.includes("close_session"), false);
  assert.equal(context.includes("global-project-id"), false);
});

test("v7 keeps the short per-prompt reminder when the session bridge is present or undecided", () => {
  for (const [bridgeCommand, bridgePresent] of [
    [
      "node /Users/x/plugins/recall/bridge/index.mjs --client-name Claude",
      true,
    ],
    [null, false],
  ]) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v7"),
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PATH: makeFakePsDirectory({
          bridgeCommand,
          hostCommand: bridgePresent
            ? undefined
            : "node /repo/tests/run-everything.mjs",
        }),
        TMPDIR: makeTemporaryDirectory(),
      },
      input: claudeV5PromptInput,
    });

    assert.equal(
      contextOf(result, String(bridgeCommand)),
      claudeAdjustedV7Fixture("repository-with-global-reminder.txt"),
      String(bridgeCommand),
    );
  }
});

test("v7 session start never runs connector detection", () => {
  const markerPath = path.join(makeTemporaryDirectory(), "ps-invocations");
  const result = runHook({
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: path.join(fixtureRoot, "v7"),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: makeFakePsDirectory({ markerPath }),
      TMPDIR: makeTemporaryDirectory(),
    },
    input: claudeV5Input,
  });

  assert.equal(
    contextOf(result),
    claudeAdjustedV7Fixture("repository-with-global-context.txt"),
  );
  assert.equal(fs.existsSync(markerPath), false);
});

test("v7 Cursor reads its own config and routes through the same rungs", () => {
  const savedRoot = makeTemporaryDirectory();
  const result = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: makeConfigDirectory(
        v7Config({ paths: { [savedRoot]: v7PathDestination() } }),
      ),
    },
    input: {
      hook_event_name: "sessionStart",
      workspace_roots: [savedRoot],
      conversation_id: v5ThreadId,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.additional_context, /version 7 is enabled for Cursor/);
  assert.match(output.additional_context, /projectUuid path-project-id/);
  assert.match(output.additional_context, /open_session\.effortUuid/);
  assert.match(output.additional_context, /record_milestone/);
  assert.match(output.additional_context, /Load \/recall-journal/);
  assert.equal(output.additional_context.includes(savedRoot), false);
});

function claudeV7Environment(config) {
  return {
    ...cleanEnvironment(),
    CLAUDE_CONFIG_DIR: makeConfigDirectory(config),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    PATH: makeFakePsDirectory({
      bridgeCommand:
        "node /plugins/recall/bridge/index.mjs --client-name Claude",
    }),
    TMPDIR: makeTemporaryDirectory(),
  };
}

test("v7 and legacy configs reject a saved root that is a symlink to the filesystem root", () => {
  const link = path.join(makeTemporaryDirectory(), "scope");
  fs.symlinkSync(path.parse(repositoryRoot).root, link);
  for (const config of [
    v7Config({ paths: { [link]: v7PathDestination() } }),
    v7Config({ global: null, paths: { [link]: v7PathDestination() } }),
    configWithProject(link),
  ]) {
    for (const cwd of [repositoryRoot, makeTemporaryDirectory()]) {
      const result = runV7Hook(makeConfigDirectory(config), cwd);
      assertInvalidConfigContext(result, JSON.stringify(config));
    }
  }
});

test("v7 rejects two saved roots that canonicalize to the same directory", () => {
  const root = makeTemporaryDirectory();
  const alias = path.join(makeTemporaryDirectory(), "alias");
  fs.symlinkSync(root, alias);
  for (const paths of [
    { [root]: v7PathDestination(), [alias]: v7PathDestination() },
    {
      [root]: v7PathDestination(),
      [`${root}${path.sep}`]: v7PathDestination(),
    },
  ]) {
    const result = runV7Hook(makeConfigDirectory(v7Config({ paths })), root);
    assertInvalidConfigContext(result, Object.keys(paths).join(", "));
  }
  // One alias still matches through its canonical root.
  const context = v7Context(
    runV7Hook(
      makeConfigDirectory(
        v7Config({ paths: { [alias]: v7PathDestination() } }),
      ),
      root,
    ),
  );
  assert.match(context, /projectUuid path-project-id/);
  assertNoV7Leak(context, root, alias);
});

test("v7 stops honoring a saved root retargeted at the filesystem root after setup", () => {
  const root = path.join(makeTemporaryDirectory(), "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const configDirectory = makeConfigDirectory(
    v7Config({ paths: { [root]: v7PathDestination() } }),
  );
  assert.match(
    v7Context(runV7Hook(configDirectory, path.join(root, "src"))),
    /projectUuid path-project-id/,
  );

  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(path.parse(root).root, root);
  for (const cwd of [makeTemporaryDirectory(), repositoryRoot]) {
    const result = runV7Hook(configDirectory, cwd);
    assertInvalidConfigContext(result, cwd);
  }
});

test("a paths-only v7 file still journals in an exactly bound repository outside its paths", () => {
  const context = v7Context(
    runV7Hook(
      makeConfigDirectory(
        v7Config({
          global: null,
          paths: { "/Users/example/projects/bound-app": v7PathDestination() },
        }),
      ),
      repositoryRoot,
    ),
  );
  assert.match(context, /repository-first routing/);
  assert.match(context, /call resolve_project/);
  assert.match(context, /Version 7 is the structured writer/);
  assert.equal(context.includes("path-project-id"), false);
  const configuration = fs.readFileSync(
    path.join(
      repositoryRoot,
      "plugins/recall/skills/recall-journal/references/configuration.md",
    ),
    "utf8",
  );
  assert.match(
    configuration,
    /is \*\*not\*\* scoped to its saved\s+paths alone/,
  );
});

test("an inert v6 file becomes an automatic writer only through an explicit v7 conversion", () => {
  const destination = v7GlobalDestination();
  const inert = {
    version: 6,
    projectMemory: { enabled: true, defaultProject: destination },
    sessionLifecycle: { enabled: false },
  };
  const converted = v7Config({
    global: destination,
    sessionLifecycle: { enabled: false },
  });
  const run = (config) =>
    runHook({
      args: ["--host", "claude-code"],
      environment: claudeV7Environment(config),
      input: claudeV5Input,
    });

  const before = run(inert);
  assert.equal(before.status, 0);
  assert.equal(before.stderr, "");
  assert.equal(before.stdout, "");

  const after = run(converted);
  assert.equal(after.status, 0);
  const context = JSON.parse(after.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Version 7 is the structured writer/);
  assert.match(context, /open_session/);
  assert.match(context, /projectUuid global-project-id/);

  const configuration = fs.readFileSync(
    path.join(
      repositoryRoot,
      "plugins/recall/skills/recall-journal/references/configuration.md",
    ),
    "utf8",
  );
  assert.match(
    configuration,
    /Converting such a file\s+therefore turns automatic journaling on/,
  );
  assert.match(
    configuration,
    /A version 4 file is reader-only; the version 7 file that replaces it is a\s+writer/,
  );
});

test("both readers honor one config-size bound for large v7 files", () => {
  const manyPaths = (count, padding) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/Users/example/projects/${"app".padEnd(padding, "x")}-${index}`,
        v7PathDestination(),
      ]),
    );
  const sizeOf = (config) => Buffer.byteLength(JSON.stringify(config));
  const run = (config, input = claudeV5Input) =>
    runHook({
      args: ["--host", "claude-code"],
      environment: claudeV7Environment(config),
      input,
    });

  const large = manyPaths(140, 3);
  assert.ok(sizeOf(v7Config({ paths: large })) > 16 * 1024);
  assert.ok(sizeOf(v7Config({ paths: large })) < 64 * 1024);
  const writer = run(
    v7Config({ paths: large, sessionLifecycle: { enabled: false } }),
  );
  assert.equal(writer.status, 0);
  assert.match(
    JSON.parse(writer.stdout).hookSpecificOutput.additionalContext,
    /Version 7 is the structured writer/,
  );
  const pilot = run(
    v7Config({ paths: large, sessionLifecycle: { enabled: true } }),
    claudeV5PromptInput,
  );
  assert.equal(pilot.status, 0);
  assert.match(
    JSON.parse(pilot.stdout).hookSpecificOutput.additionalContext,
    /opt-in version 6 conversation-segment adapter/,
  );

  const oversized = manyPaths(600, 40);
  assert.ok(sizeOf(v7Config({ paths: oversized })) > 64 * 1024);
  for (const enabled of [false, true]) {
    const result = run(
      v7Config({ paths: oversized, sessionLifecycle: { enabled } }),
    );
    assert.match(
      assertInvalidConfigContext(result, String(enabled)),
      /larger than the 64 KiB bound/,
      String(enabled),
    );
  }
});

// Versions 5 and 7 open the session before the context read so that read can
// be anchored to the predecessor open_session hands back. The anchor is gated
// on the live get_project_context schema, never on a version or a config field.
test("v5 and v7 open the session before the context read and gate the delta read on the live schema", () => {
  const writerFixtures = [
    ["v5", "repository-context.txt"],
    ["v5", "no-repository-context.txt"],
    ["v7", "path-context.txt"],
    ["v7", "path-in-repository-context.txt"],
    ["v7", "path-in-linked-worktree-context.txt"],
    ["v7", "repository-with-global-context.txt"],
    ["v7", "repository-without-global-context.txt"],
    ["v7", "no-repository-context.txt"],
  ];
  for (const [version, filename] of writerFixtures) {
    const context = readFixture(version, filename);
    const label = `${version}/${filename}`;
    assert.match(
      context,
      /open_session on the resolved Project first, then call get_project_context for that same Project and use that compact context before deeper searches/,
      label,
    );
    assert.match(
      context,
      /Pass previousSession\.sessionUuid as sinceSessionUuid only when open_session returned a CLOSED previousSession with contentAvailable true and contentTruncated not true and that schema advertises the anchor; otherwise read the full context/,
      label,
    );
    assert.match(context, /callerSessionUuid, profile journal, noteLimit 2, and entryLimit 6/, label);
    // Losing the reader never costs the writer: only the session tools or a
    // failed open stop journaling.
    assert.match(
      context,
      /A read that is unavailable, fails, or is not ready never undoes the session: keep journaling to it and work without that context/,
      label,
    );
    assert.doesNotMatch(context, /either tool is unavailable/, label);
    assert.match(
      context,
      /(?:resolve_project or )?the session tools are unavailable/,
      label,
    );
    // The old order — a context read before the session opened — is gone.
    assert.doesNotMatch(
      context,
      /Before substantive work, require get_project_context/,
      label,
    );
    assert.doesNotMatch(
      context,
      /or project context is not ready, continue without project memory/,
      label,
    );
    // No anchor value is ever printed by the hook: it comes from open_session.
    assert.doesNotMatch(context, /sinceSessionUuid [0-9a-f-]{36}/, label);
    assert.equal(
      context.split("named multi-session effort").length - 1,
      1,
      label,
    );
  }

  // Direct routes name the saved ids once for both the session tools and the
  // context read, and still check the context result against them.
  for (const [version, filename] of [
    ["v5", "no-repository-context.txt"],
    ["v7", "path-context.txt"],
    ["v7", "path-in-repository-context.txt"],
    ["v7", "no-repository-context.txt"],
  ]) {
    assert.match(
      readFixture(version, filename),
      /Use it directly for the session tools and get_project_context, passing workspaceId [\w-]+ and projectUuid [\w-]+, and accept only a context result whose project id and workspaceId match that saved (?:target|destination)\./,
      `${version}/${filename}`,
    );
  }
  assert.match(
    readFixture("v7", "repository-with-global-context.txt"),
    /fall back to the global [^:]+: use it directly for the session tools and get_project_context, passing workspaceId global-workspace-id and projectUuid global-project-id/,
  );

  // Reader-only versions open nothing, so they never see the anchor rule.
  for (const [version, filename] of [
    ["v3", "additional-context.txt"],
    ["v4", "repository-context.txt"],
    ["v4", "no-repository-context.txt"],
  ]) {
    assert.doesNotMatch(
      readFixture(version, filename),
      /sinceSessionUuid|previousSession|record_milestone\.todayCard/,
      `${version}/${filename}`,
    );
  }

  for (const [version, filename] of [
    ["v5", "bridge-missing-reminder.txt"],
    ["v7", "bridge-missing-reminder.txt"],
    ["v7", "unknown-identity-context.txt"],
  ]) {
    assert.doesNotMatch(
      readFixture(version, filename),
      /record_milestone\.todayCard|open_session\.effortUuid|record_milestone/,
      `${version}/${filename}`,
    );
  }

  // The per-prompt reminder points at the session context; it never recites
  // the protocol, the anchor rule, or the upgrade offer.
  for (const [version, filename] of [
    ["v5", "repository-reminder.txt"],
    ["v5", "no-repository-reminder.txt"],
    ["v7", "path-reminder.txt"],
    ["v7", "repository-with-global-reminder.txt"],
    ["v7", "repository-without-global-reminder.txt"],
    ["v7", "no-repository-reminder.txt"],
  ]) {
    const reminder = readFixture(version, filename);
    const label = `${version}/${filename}`;
    assert.match(reminder, /Follow the Recall session-start context/, label);
    assert.match(reminder, new RegExp(`lineageKey ${v5ThreadId}`), label);
    assert.doesNotMatch(
      reminder,
      /open_session on the resolved Project|sinceSessionUuid|daySummary|record_milestone|This config is version|append_entry/,
      label,
    );
    assert.ok(Buffer.byteLength(reminder) <= 400, `${label}: ${Buffer.byteLength(reminder)}`);
  }
});

// Every valid config older than version 7 carries exactly one upgrade offer.
// It names the host's skill and hands the decision to the user; it never
// authorizes the hook to rewrite the file.
test("offers the version 7 upgrade once per session start and never on a prompt", () => {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const offer = (version, skill) =>
    new RegExp(
      `${escape(` This config is version ${version}; version 7 is the current shape. Once per session, when finalizing meaningful work (immediately on an explicit invocation), offer to upgrade it to version 7 through ${skill}, which explains the consequences and writes only after the user confirms; leave the file unchanged if they decline or do not answer, and never rewrite it from this context.`)}$`,
    );
  const v5 = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "v5", "recall-journal.json"), "utf8"),
  );
  for (const [version, config] of [
    [1, validConfig()],
    [2, validV2Config()],
    [3, validV3Config()],
    [4, validV4Config()],
    [5, v5],
  ]) {
    const result = runHook({
      environment: {
        ...cleanEnvironment(),
        CODEX_HOME: makeConfigDirectory(config),
        PLUGIN_ROOT: pluginRoot,
      },
      input: {
        hook_event_name: "SessionStart", source: "startup",
        cwd: repositoryRoot,
        session_id: v5ThreadId,
      },
    });
    assert.equal(result.status, 0, String(version));
    assert.equal(result.stderr, "", String(version));
    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext;
    assert.match(context, offer(version, "$recall:recall-journal"), String(version));
    assert.equal(
      context.split("This config is version").length - 1,
      1,
      String(version),
    );
  }

  // The version 6 adapter context carries the same offer for its host.
  const v6 = runHook({
    args: ["--host", "claude-code"],
    environment: {
      ...cleanEnvironment(),
      CLAUDE_CONFIG_DIR: v6ConfigDirectory(),
      PATH: makeFakePsDirectory({
        bridgeCommand:
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
      }),
    },
    input: claudeV5PromptInput,
  });
  assert.equal(v6.status, 0, v6.stderr);
  const v6Context = JSON.parse(v6.stdout).hookSpecificOutput.additionalContext;
  assert.match(v6Context, /opt-in version 6 conversation-segment adapter/);
  assert.match(v6Context, offer(6, "/recall:recall-journal"));

  // The per-prompt reminder never repeats the offer.
  const reminder = runHook({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: makeConfigDirectory(v5),
      PLUGIN_ROOT: pluginRoot,
    },
    input: claudeV5PromptInput,
  });
  assert.doesNotMatch(contextOf(reminder), /This config is version/);

  // Cursor names its own skill.
  const cursor = runHook({
    args: ["--host", "cursor"],
    environment: {
      ...cleanEnvironment(),
      CURSOR_HOME: makeConfigDirectory(validV2Config()),
    },
    input: {
      hook_event_name: "sessionStart",
      session_id: "cursor-conversation-123",
      workspace_roots: [makeProjectDirectory("cursor-project")],
    },
  });
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.match(
    JSON.parse(cursor.stdout).additional_context,
    offer(2, "/recall-journal"),
  );
});

test("the upgrade offer is absent for version 7, an inert version 6 file, and a missing connector", () => {
  const current = runHook({
    args: ["--host", "claude-code"],
    environment: claudeV7Environment(
      v7Config({ global: v7GlobalDestination() }),
    ),
    input: claudeV5Input,
  });
  assert.equal(current.status, 0, current.stderr);
  const context = JSON.parse(current.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(context, /version 7 is enabled/);
  assert.doesNotMatch(context, /This config is version/);

  // An inert version 6 file was turned off on purpose; it is never nagged.
  const inert = runHook({
    args: ["--host", "claude-code"],
    environment: claudeV7Environment({
      version: 6,
      projectMemory: { enabled: true, defaultProject: v7GlobalDestination() },
      sessionLifecycle: { enabled: false },
    }),
    input: claudeV5Input,
  });
  assert.equal(inert.status, 0, inert.stderr);
  assert.equal(inert.stdout, "");

  // With no connector there is nothing to revalidate against, so the
  // per-prompt missing-bridge reminder stands alone.
  const missing = runHook({
    environment: claudeV5Environment({
      psDirectory: makeFakePsDirectory(),
      temporaryDirectory: makeTemporaryDirectory(),
    }),
    input: claudeV5PromptInput,
  });
  assert.equal(missing.status, 0, missing.stderr);
  const missingContext = JSON.parse(missing.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(missingContext, /no Recall bridge child/);
  assert.doesNotMatch(missingContext, /This config is version/);
});
