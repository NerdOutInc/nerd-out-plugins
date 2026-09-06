import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  CURRENT_JOURNAL_CONFIG_VERSION,
  describeInvalidJournalConfig,
  journalConfigPath,
  journalSkillName,
  readJournalConfigFile,
  readValidJournalConfig,
  sanitizeJournalConfig,
  upgradeAvailableContext,
} from "../plugins/recall/bridge/journal-config.mjs";
import { readLifecycleConfig } from "../plugins/recall/bridge/session-lifecycle-routing.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-config-"));
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

const destination = {
  workspace: { id: "workspace-one", name: "Workspace" },
  recallProject: { id: "project-one", name: "Project" },
};
const configs = {
  1: {
    version: 1,
    scope: "global",
    workspace: destination.workspace,
    journal: { dailyNote: true },
  },
  2: {
    version: 2,
    journal: { summaryTarget: "today", dailyNote: false },
    global: destination,
  },
  3: { version: 3, projectMemory: { enabled: true } },
  4: { version: 4, projectMemory: { enabled: true, defaultProject: destination } },
  5: { version: 5, projectMemory: { enabled: true, defaultProject: destination } },
  6: {
    version: 6,
    projectMemory: { enabled: true, defaultProject: destination },
    sessionLifecycle: { enabled: true },
  },
  7: {
    version: 7,
    projectMemory: { enabled: true, global: destination },
    sessionLifecycle: { enabled: false },
  },
};

test("classifies every supported version and keeps version 6 out of the hook's view", () => {
  assert.equal(CURRENT_JOURNAL_CONFIG_VERSION, 7);
  for (const [version, config] of Object.entries(configs)) {
    const { file } = writeConfig(config);
    const result = readJournalConfigFile(file);
    assert.equal(result.status, "valid", version);
    assert.equal(result.version, Number(version), version);
    assert.deepEqual(result.raw, config, version);
    assert.deepEqual(result.config, sanitizeJournalConfig(config), version);
    if (Number(version) >= 3) {
      assert.equal(result.config.projectMemory.version, Number(version));
    } else {
      assert.equal(result.config.globalDestination.workspace.id, "workspace-one");
    }
    // Version 6 is the lifecycle adapter's file: the prompt hook reads it as
    // nothing, exactly as it did before the shared reader existed.
    assert.equal(readValidJournalConfig(file) === null, version === "6", version);
  }
  assert.deepEqual(readJournalConfigFile(writeConfig(configs[6]).file).config, {
    projectMemory: { defaultProject: destination, version: 6 },
    sessionLifecycle: { enabled: true },
  });
  assert.deepEqual(
    readJournalConfigFile(
      writeConfig({
        ...configs[6],
        sessionLifecycle: { enabled: false, codexParticipantVerified: true },
      }).file,
    ).config.sessionLifecycle,
    { codexParticipantVerified: true, enabled: false },
  );
});

test("reports missing, unreadable, and invalid files by reason", () => {
  const missing = path.join(makeTemporaryDirectory(), "recall-journal.json");
  assert.deepEqual(readJournalConfigFile(missing), { status: "missing" });
  assert.deepEqual(readJournalConfigFile(makeTemporaryDirectory()), {
    status: "unreadable",
  });
  assert.deepEqual(readJournalConfigFile(writeConfig("not json").file), {
    reason: "malformed_json",
    status: "invalid",
  });
  assert.deepEqual(
    readJournalConfigFile(
      writeConfig({ version: 8, projectMemory: { enabled: true } }).file,
    ),
    { reason: "newer_version", status: "invalid", version: 8 },
  );
  for (const value of [{}, { version: "7" }, { version: 2.5 }, [], null]) {
    assert.deepEqual(
      readJournalConfigFile(writeConfig(value).file),
      { reason: "unsupported_version", status: "invalid" },
      JSON.stringify(value),
    );
  }
  assert.deepEqual(readJournalConfigFile(writeConfig({ version: 0 }).file), {
    reason: "unsupported_version",
    status: "invalid",
    version: 0,
  });
  assert.deepEqual(readJournalConfigFile(writeConfig({ version: 5 }).file), {
    reason: "invalid_shape",
    status: "invalid",
    version: 5,
  });
  const oversized = {
    ...configs[7],
    projectMemory: {
      ...configs[7].projectMemory,
      paths: Object.fromEntries(
        Array.from({ length: 700 }, (_, index) => [
          `/Users/example/projects/${"x".repeat(60)}-${index}`,
          destination,
        ]),
      ),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 64 * 1024);
  assert.deepEqual(readJournalConfigFile(writeConfig(oversized).file), {
    reason: "oversized",
    status: "invalid",
  });

  assert.match(
    describeInvalidJournalConfig({ reason: "oversized" }),
    /64 KiB/,
  );
  assert.match(
    describeInvalidJournalConfig({ reason: "malformed_json" }),
    /not valid JSON/,
  );
  assert.match(
    describeInvalidJournalConfig({ reason: "newer_version", version: 8 }),
    /version 8 is newer than this plugin supports/,
  );
  assert.match(
    describeInvalidJournalConfig({ reason: "unsupported_version" }),
    /version field is missing/,
  );
  assert.match(
    describeInvalidJournalConfig({ reason: "unsupported_version", version: 0 }),
    /version 0 is not a supported/,
  );
  assert.match(
    describeInvalidJournalConfig({ reason: "invalid_shape", version: 5 }),
    /exact version 5 shape/,
  );
});

// The lifecycle adapter keeps its own reader for routing; the shared reader
// must agree with it about which version 6 and 7 files are valid, or a file
// could be reported as invalid by the hook while the adapter records to it.
test("version 6 and 7 validity agrees with the lifecycle adapter's reader", async () => {
  const cases = [
    [configs[6], true],
    [configs[7], true],
    [{ ...configs[6], global: {} }, false],
    [{ ...configs[6], sessionLifecycle: { enabled: true, unknown: true } }, false],
    [{ ...configs[6], sessionLifecycle: { enabled: false } }, true],
    [
      {
        ...configs[6],
        sessionLifecycle: { enabled: true, codexParticipantVerified: true },
      },
      true,
    ],
    [{ version: 6, projectMemory: configs[6].projectMemory }, false],
    [
      {
        version: 6,
        projectMemory: {
          enabled: true,
          defaultProject: { workspace: destination.workspace },
        },
        sessionLifecycle: { enabled: true },
      },
      false,
    ],
    [
      {
        version: 6,
        projectMemory: {
          enabled: true,
          defaultProject: {
            ...destination,
            workspace: { id: "workspace one", name: "Workspace" },
          },
        },
        sessionLifecycle: { enabled: true },
      },
      false,
    ],
    [
      {
        version: 6,
        projectMemory: {
          enabled: true,
          defaultProject: {
            ...destination,
            recallProject: { id: "project-one", name: "p".repeat(300) },
          },
        },
        sessionLifecycle: { enabled: true },
      },
      false,
    ],
    [{ version: 7, projectMemory: { enabled: true, global: destination } }, true],
    [{ version: 7, projectMemory: { enabled: true, paths: [] } }, false],
    [
      {
        version: 7,
        projectMemory: {
          enabled: true,
          paths: { "/fixture/bound": destination, "/fixture/bound/": destination },
        },
      },
      false,
    ],
    [
      { version: 7, projectMemory: { enabled: true, paths: { "/fixture/bound": null } } },
      false,
    ],
    [
      {
        version: 7,
        projectMemory: {
          enabled: true,
          global: destination,
          paths: { "/fixture/bound": destination },
        },
        sessionLifecycle: { enabled: true },
      },
      true,
    ],
  ];
  for (const [value, valid] of cases) {
    const { directory, file } = writeConfig(value);
    const label = JSON.stringify(value).slice(0, 160);
    assert.equal(readJournalConfigFile(file).status === "valid", valid, label);
    let adapterValid;
    try {
      await readLifecycleConfig("claude-code", { CLAUDE_CONFIG_DIR: directory });
      adapterValid = true;
    } catch {
      adapterValid = false;
    }
    assert.equal(adapterValid, valid, label);
  }
});

test("names the per-host config path and skill, and offers the upgrade without authorizing it", () => {
  assert.equal(
    journalConfigPath("codex", { CODEX_HOME: "/tmp/codex-home" }),
    "/tmp/codex-home/recall-journal.json",
  );
  assert.equal(
    journalConfigPath("claude-code", { CLAUDE_CONFIG_DIR: "/tmp/claude" }),
    "/tmp/claude/recall-journal.json",
  );
  assert.equal(
    journalConfigPath("cursor", { CURSOR_HOME: "/tmp/cursor" }),
    "/tmp/cursor/recall-journal.json",
  );
  assert.equal(journalSkillName("codex"), "$recall:recall-journal");
  assert.equal(journalSkillName("claude-code"), "/recall:recall-journal");
  assert.equal(journalSkillName("cursor"), "/recall-journal");

  const offer = upgradeAvailableContext(5, "/recall:recall-journal");
  assert.match(offer, /^ This config is version 5; version 7 is the current shape\./);
  assert.match(offer, /Once per session/);
  assert.match(offer, /immediately on an explicit invocation/);
  assert.match(offer, /through \/recall:recall-journal/);
  assert.match(offer, /writes only after the user confirms/);
  assert.match(offer, /leave the file unchanged if they decline or do not answer/);
  assert.match(offer, /never rewrite it from this context\.$/);
  assert.equal(offer.includes("\n"), false);
  assert.ok(offer.length < 420, `offer rides on every prompt: ${offer.length}`);
});
