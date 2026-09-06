import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readJournalConfigFile } from "../plugins/recall/bridge/journal-config.mjs";
import {
  applyJournalConfig,
  parseUpgradeArguments,
  planJournalConfigUpgrade,
  runUpgradeCommand,
} from "../plugins/recall/skills/recall-journal/scripts/journal-config-upgrade.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptsDirectory = path.join(
  repositoryRoot,
  "plugins/recall/skills/recall-journal/scripts",
);
const helperScript = path.join(scriptsDirectory, "journal-config-upgrade.mjs");
const helperWrapper = path.join(scriptsDirectory, "upgrade-journal-config");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-upgrade-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(value) {
  const directory = makeTemporaryDirectory();
  const file = path.join(directory, "recall-journal.json");
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return { directory, file };
}

function plan(value, options) {
  return planJournalConfigUpgrade(
    readJournalConfigFile(writeConfig(value).file),
    options,
  );
}

const workspace = { id: "workspace-one", name: "Workspace" };
const otherWorkspace = { id: "workspace-two", name: "Other workspace" };
const project = { id: "project-one", name: "Project" };
const destination = { workspace, recallProject: project };
const otherDestination = {
  workspace: otherWorkspace,
  recallProject: { id: "project-two", name: "Other project" },
};
const ids = (items) => items.map((item) => item.id);
const questions = (result) =>
  result.questions.map((question) => [question.id, question.required]);
const v5Config = () => ({
  version: 5,
  projectMemory: { enabled: true, defaultProject: destination },
});
const v7File = () => ({
  version: 7,
  projectMemory: { enabled: true, global: destination },
  sessionLifecycle: { enabled: false },
});

test("v5 translates mechanically into a global destination with its routing consequence", () => {
  const result = plan(v5Config(), {
    filesystemProject: { repository: true, root: "/fixture/repo" },
  });
  assert.equal(result.status, "upgradable");
  assert.equal(result.sourceVersion, 5);
  assert.equal(result.targetVersion, 7);
  assert.deepEqual(result.proposed, v7File());
  assert.deepEqual(Object.keys(result.proposed), [
    "version",
    "projectMemory",
    "sessionLifecycle",
  ]);
  assert.deepEqual(result.carried, [{ scope: "global", ...destination }]);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(ids(result.consequences), [
    "global_receives_unbound_repositories",
    "archive_untouched",
  ]);
  assert.match(result.consequences[0].text, /which version 5 refused/);
  assert.deepEqual(questions(result), [
    ["global_project", false],
    ["add_current_path", false],
  ]);
  assert.match(result.questions[0].text, /Project "Project" \(project-one\)/);
  assert.match(result.questions[1].text, /\/fixture\/repo/);
  assert.deepEqual(result.filesystemProject, {
    repository: true,
    root: "/fixture/repo",
  });

  // Without a resolved filesystem project there is no path to offer.
  assert.deepEqual(questions(plan(v5Config())), [["global_project", false]]);
});

test("v6 keeps its pilot block exactly and says whether journaling turns on", () => {
  const enabled = plan({
    version: 6,
    projectMemory: { enabled: true, defaultProject: destination },
    sessionLifecycle: { enabled: true, codexParticipantVerified: true },
  });
  assert.equal(enabled.status, "upgradable");
  assert.deepEqual(enabled.proposed.sessionLifecycle, {
    enabled: true,
    codexParticipantVerified: true,
  });
  assert.deepEqual(ids(enabled.consequences), [
    "global_receives_unbound_repositories",
    "pilot_kept",
    "archive_untouched",
  ]);

  const inert = plan({
    version: 6,
    projectMemory: { enabled: true, defaultProject: destination },
    sessionLifecycle: { enabled: false },
  });
  assert.equal(inert.status, "upgradable");
  assert.deepEqual(inert.proposed.sessionLifecycle, { enabled: false });
  assert.deepEqual(ids(inert.consequences), [
    "global_receives_unbound_repositories",
    "journaling_turns_on",
    "archive_untouched",
  ]);
  assert.match(inert.consequences[1].text, /turns automatic structured journaling on/);
});

test("v4 and v3 are readers whose upgrade makes a writer", () => {
  const v4 = plan({
    version: 4,
    projectMemory: { enabled: true, defaultProject: destination },
  });
  assert.equal(v4.status, "upgradable");
  assert.deepEqual(v4.proposed, v7File());
  assert.deepEqual(ids(v4.consequences), [
    "reader_becomes_writer",
    "global_receives_unbound_repositories",
    "archive_untouched",
  ]);
  assert.match(v4.consequences[0].text, /Version 4 is reader-only/);

  const v3 = plan({ version: 3, projectMemory: { enabled: true } });
  assert.equal(v3.status, "needs_input");
  assert.equal(v3.proposed, null);
  assert.deepEqual(v3.carried, []);
  assert.deepEqual(ids(v3.consequences), [
    "reader_becomes_writer",
    "archive_untouched",
  ]);
  assert.deepEqual(questions(v3), [["choose_destination", true]]);
});

test("legacy files carry Project-scoped destinations and ask about every workspace root", () => {
  const mixed = plan({
    version: 2,
    journal: { summaryTarget: "none", dailyNote: false },
    global: destination,
    projects: {
      "/fixture/a": { workspace: otherWorkspace },
      "/fixture/b": otherDestination,
    },
  });
  assert.equal(mixed.status, "needs_input");
  assert.deepEqual(mixed.carried, [
    { scope: "global", ...destination },
    { scope: "path", root: "/fixture/b", ...otherDestination },
  ]);
  assert.deepEqual(mixed.dropped, [
    {
      scope: "path",
      root: "/fixture/a",
      workspace: otherWorkspace,
      reason: "workspace_root",
    },
  ]);
  assert.deepEqual(mixed.proposed, {
    version: 7,
    projectMemory: {
      enabled: true,
      global: destination,
      paths: { "/fixture/b": otherDestination },
    },
    sessionLifecycle: { enabled: false },
  });
  assert.deepEqual(ids(mixed.consequences), [
    "mode_change",
    "routing_outside_saved_paths",
    "no_summary_preference",
    "archive_untouched",
  ]);
  assert.deepEqual(questions(mixed), [
    ["choose_project:path:/fixture/a", true],
    ["global_project", false],
  ]);
  assert.match(mixed.questions[0].text, /the root of workspace "Other workspace"/);

  const projectScoped = plan({
    version: 2,
    journal: { summaryTarget: "today", dailyNote: false },
    projects: { "/fixture/b": otherDestination },
  });
  assert.equal(projectScoped.status, "upgradable");
  assert.equal(projectScoped.proposed.projectMemory.global, undefined);
  assert.deepEqual(ids(projectScoped.consequences), [
    "mode_change",
    "routing_outside_saved_paths",
    "summary_target_replaced",
    "no_global_destination",
    "archive_untouched",
  ]);
  assert.match(projectScoped.consequences[2].text, /Today summary setting/);
  assert.deepEqual(questions(projectScoped), []);

  const v1 = plan({
    version: 1,
    scope: "global",
    workspace,
    journal: { dailyNote: true },
    projects: { "/fixture/a": { workspace: otherWorkspace } },
  });
  assert.equal(v1.status, "needs_input");
  assert.equal(v1.proposed, null);
  assert.deepEqual(v1.carried, []);
  assert.deepEqual(
    v1.dropped.map((entry) => [entry.scope, entry.root ?? null, entry.reason]),
    [
      ["global", null, "workspace_root"],
      ["path", "/fixture/a", "workspace_root"],
    ],
  );
  assert.match(
    v1.consequences.find((item) => item.id === "summary_target_replaced").text,
    /retired DailyNote/,
  );
  assert.deepEqual(questions(v1), [
    ["choose_project:global", true],
    ["choose_project:path:/fixture/a", true],
  ]);

  // Two legacy keys for one directory cannot both survive: version 7 rejects
  // duplicate canonical roots, so the second one is dropped and asked about.
  const duplicated = plan({
    version: 2,
    journal: { summaryTarget: "none", dailyNote: false },
    projects: { "/fixture/a": destination, "/fixture/a/": otherDestination },
  });
  assert.equal(duplicated.status, "needs_input");
  assert.deepEqual(Object.keys(duplicated.proposed.projectMemory.paths), [
    "/fixture/a",
  ]);
  assert.deepEqual(duplicated.dropped[0].reason, "duplicate_root");
  assert.deepEqual(questions(duplicated), [
    ["resolve_duplicate:/fixture/a/", true],
  ]);
});

test("current, missing, unreadable, and invalid files are not upgrade plans", () => {
  const current = plan({
    version: 7,
    projectMemory: {
      enabled: true,
      global: destination,
      paths: { "/fixture/b": otherDestination },
    },
    sessionLifecycle: { enabled: true },
  });
  assert.equal(current.status, "current");
  assert.equal(current.proposed, null);
  assert.deepEqual(current.carried, [
    { scope: "global", ...destination },
    { scope: "path", root: "/fixture/b", ...otherDestination },
  ]);
  assert.deepEqual(current.questions, []);

  const missing = planJournalConfigUpgrade({ status: "missing" });
  assert.equal(missing.status, "missing");
  assert.equal(missing.sourceVersion, null);
  assert.deepEqual(questions(missing), [["first_setup", true]]);

  const unreadable = planJournalConfigUpgrade({ status: "unreadable" });
  assert.equal(unreadable.status, "unreadable");
  assert.deepEqual(questions(unreadable), [["unreadable", true]]);

  const invalid = plan({ version: 1 });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.sourceVersion, 1);
  assert.deepEqual(invalid.invalid, {
    reason: "invalid_shape",
    description: "its contents do not match the exact version 1 shape",
  });
  assert.deepEqual(questions(invalid), [["repair", true]]);
  assert.match(invalid.questions[0].text, /never guess a destination/);

  const newer = plan({ version: 8, projectMemory: { enabled: true } });
  assert.equal(newer.status, "invalid");
  assert.match(newer.invalid.description, /newer than this plugin supports/);
  assert.equal(plan("not json").invalid.reason, "malformed_json");
});

test("apply writes a validated version 7 file atomically and guards the source version", () => {
  const { directory, file } = writeConfig(v5Config());
  const result = applyJournalConfig(file, v7File(), { expectVersion: 5 });
  assert.deepEqual(result, {
    status: "written",
    version: 7,
    previous: { status: "valid", version: 5 },
    verified: true,
  });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    `${JSON.stringify(v7File(), null, 2)}\n`,
  );
  assert.deepEqual(fs.readdirSync(directory), ["recall-journal.json"]);

  // The plan named version 5; a file that changed underneath is refused.
  const stale = applyJournalConfig(file, v7File(), { expectVersion: 5 });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "version_mismatch");
  assert.deepEqual(stale.current, { status: "valid", version: 7 });
  assert.equal(
    applyJournalConfig(
      path.join(makeTemporaryDirectory(), "recall-journal.json"),
      v7File(),
      { expectVersion: 5 },
    ).reason,
    "version_mismatch",
  );

  // Repair writes without an expectation, creating the directory if needed.
  const fresh = path.join(makeTemporaryDirectory(), "nested", "recall-journal.json");
  const repaired = applyJournalConfig(fresh, v7File());
  assert.deepEqual(repaired, {
    status: "written",
    version: 7,
    previous: { status: "missing" },
    verified: true,
  });
  assert.equal(readJournalConfigFile(fresh).version, 7);

  const untouched = writeConfig(v5Config());
  const before = fs.readFileSync(untouched.file, "utf8");
  assert.equal(
    applyJournalConfig(untouched.file, v5Config()).reason,
    "unsupported_version",
  );
  assert.equal(
    applyJournalConfig(untouched.file, {
      version: 7,
      projectMemory: { enabled: true, global: { workspace } },
    }).reason,
    "invalid_shape",
  );
  const oversized = v7File();
  oversized.projectMemory.paths = Object.fromEntries(
    Array.from({ length: 700 }, (_, index) => [
      `/Users/example/projects/${"x".repeat(60)}-${index}`,
      destination,
    ]),
  );
  assert.equal(applyJournalConfig(untouched.file, oversized).reason, "oversized");
  assert.equal(applyJournalConfig(untouched.file, "text").reason, "unsupported_version");
  assert.equal(fs.readFileSync(untouched.file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(untouched.directory), ["recall-journal.json"]);
});

test("the command line requires a host, plans from the agent's config directory, and applies from stdin", () => {
  const { directory } = writeConfig(v5Config());
  const env = { ...process.env, CODEX_HOME: directory };
  const planned = spawnSync(
    process.execPath,
    [helperScript, "plan", "--host", "codex", "--cwd", os.tmpdir()],
    { encoding: "utf8", env },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const output = JSON.parse(planned.stdout);
  assert.equal(output.host, "codex");
  assert.equal(output.configPath, path.join(directory, "recall-journal.json"));
  assert.equal(output.status, "upgradable");
  assert.deepEqual(output.proposed, v7File());

  const applied = spawnSync(
    process.execPath,
    [helperScript, "apply", "--host", "codex", "--expect-version", "5"],
    { encoding: "utf8", env, input: JSON.stringify(output.proposed) },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "written");
  assert.equal(
    readJournalConfigFile(path.join(directory, "recall-journal.json")).version,
    7,
  );

  const rejected = spawnSync(
    process.execPath,
    [helperScript, "apply", "--host", "codex", "--expect-version", "5"],
    { encoding: "utf8", env, input: JSON.stringify(output.proposed) },
  );
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).reason, "version_mismatch");

  const malformed = spawnSync(
    process.execPath,
    [helperScript, "apply", "--host", "codex"],
    { encoding: "utf8", env, input: "{not json" },
  );
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).reason, "malformed_json");

  const usage = spawnSync(process.execPath, [helperScript, "plan"], {
    encoding: "utf8",
    env,
  });
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /--host is required/);
  assert.match(usage.stderr, /Usage: upgrade-journal-config plan/);

  assert.throws(() => parseUpgradeArguments(["apply", "--host", "codex", "--cwd", "/x"]), /--cwd applies to plan only/);
  assert.throws(() => parseUpgradeArguments(["plan", "--host", "codex", "--input", "/x"]), /--input applies to apply only/);
  assert.throws(() => parseUpgradeArguments(["plan", "--host", "codex", "--bogus", "1"]), /Unknown option --bogus/);
  assert.throws(() => parseUpgradeArguments(["apply", "--host", "codex", "--expect-version", "x"]), /positive integer/);
  assert.throws(() => parseUpgradeArguments(["upgrade"]), /Usage:/);
  assert.deepEqual(
    parseUpgradeArguments(["apply", "--host", "cursor", "--expect-version", "6", "--input", "/tmp/x.json"]),
    { command: "apply", host: "cursor", expectVersion: 6, input: "/tmp/x.json" },
  );

  const wrapper = fs.readFileSync(helperWrapper, "utf8");
  assert.match(wrapper, /bridge\/recall-node/);
  assert.match(wrapper, /journal-config-upgrade\.mjs/);
  assert.ok(fs.statSync(helperWrapper).mode & 0o111, "wrapper is executable");
});

test("plan resolves the current filesystem project to the main checkout root", async () => {
  const configDirectory = writeConfig(v5Config()).directory;
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDirectory };
  const repository = makeTemporaryDirectory();
  const init = spawnSync("git", ["init", "-q", repository], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(init.status, 0, init.stderr);
  const subdirectory = path.join(repository, "src", "deep");
  fs.mkdirSync(subdirectory, { recursive: true });

  const inRepository = await runUpgradeCommand(
    ["plan", "--host", "claude-code", "--cwd", subdirectory],
    { env },
  );
  assert.equal(inRepository.exitCode, 0);
  assert.deepEqual(inRepository.output.filesystemProject, {
    repository: true,
    root: fs.realpathSync(repository),
  });
  assert.equal(inRepository.output.status, "upgradable");
  assert.match(
    inRepository.output.questions.find((q) => q.id === "add_current_path").text,
    new RegExp(fs.realpathSync(repository).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const plain = makeTemporaryDirectory();
  const outside = await runUpgradeCommand(
    ["plan", "--host", "claude-code", "--cwd", plain],
    { env },
  );
  assert.deepEqual(outside.output.filesystemProject, {
    repository: false,
    root: fs.realpathSync(plain),
  });

  // The filesystem root can never be a saved path, so it is never offered.
  const root = await runUpgradeCommand(
    ["plan", "--host", "claude-code", "--cwd", path.parse(plain).root],
    { env },
  );
  assert.equal(root.output.filesystemProject, null);
  assert.deepEqual(questions(root.output), [["global_project", false]]);
});
