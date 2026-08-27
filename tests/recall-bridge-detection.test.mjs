import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  bridgeStatusCachePath,
  classifyBridgePresence,
  detectBridgeStatus,
  parseProcessTable,
} from "../plugins/recall/hooks/bridge-detection.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-bridge-"));
  temporaryDirectories.push(directory);
  return directory;
}

function row(pid, ppid, command) {
  return { pid, ppid, command };
}

const HOOK_PID = 900;
const HOST_PID = 500;
const APP_PID = 100;

// The command the desktop app's claude CLI runs as, verbatim shape from a
// live session (spaces in the path and all).
const CLAUDE_CLI_COMMAND =
  "/Users/x/Library/Application Support/Claude/claude-code/2.1.246/claude.app/Contents/MacOS/claude --output-format stream-json";

// The shape a real Claude Code desktop session leaves in the process table:
// the app, a disclaimer helper, the session's claude CLI, its plugin MCP
// servers, and the hook this module runs inside.
function claudeSessionRows({ bridgeRows = [], extraRows = [] } = {}) {
  return [
    row(1, 0, "/sbin/launchd"),
    row(APP_PID, 1, "/Applications/Claude.app/Contents/MacOS/Claude"),
    row(
      499,
      APP_PID,
      `/Applications/Claude.app/Contents/Helpers/disclaimer -- ${CLAUDE_CLI_COMMAND}`,
    ),
    row(HOST_PID, 499, CLAUDE_CLI_COMMAND),
    row(501, HOST_PID, "node /plugins/other-plugin/server.mjs"),
    row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
    ...bridgeRows,
    ...extraRows,
  ];
}

test("parses padded ps output and skips malformed lines", () => {
  const rows = parseProcessTable(
    "  1 0 /sbin/launchd\n" +
      "  500   1 /Applications/Claude.app/Contents/MacOS/Claude --flag value\n" +
      "not a process line\n" +
      "\n",
  );

  assert.deepEqual(rows, [
    row(1, 0, "/sbin/launchd"),
    row(500, 1, "/Applications/Claude.app/Contents/MacOS/Claude --flag value"),
  ]);
  assert.equal(parseProcessTable(""), null);
  assert.equal(parseProcessTable(null), null);
});

test("reports present when the host has a bridge child", () => {
  const verdict = classifyBridgePresence(
    claudeSessionRows({
      bridgeRows: [
        row(
          502,
          HOST_PID,
          "node /Users/x/plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    }),
    HOOK_PID,
  );

  assert.equal(verdict.status, "present");
  assert.equal(verdict.hostPid, HOST_PID);
  assert.equal(verdict.bridgePid, 502);
});

test("reports present when the signed helper runs as a grandchild", () => {
  const verdict = classifyBridgePresence(
    claudeSessionRows({
      bridgeRows: [
        row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
        row(
          503,
          502,
          "/Applications/Recall.app/Contents/Helpers/recall-mcp-bridge --client-name Claude",
        ),
      ],
    }),
    HOOK_PID,
  );

  assert.equal(verdict.status, "present");
});

test("reports absent when the host started other servers but no bridge", () => {
  const verdict = classifyBridgePresence(claudeSessionRows(), HOOK_PID);

  assert.equal(verdict.status, "absent");
  assert.equal(verdict.hostPid, HOST_PID);
});

test("does not count a sibling session's healthy bridge", () => {
  // The incident shape: another concurrent session under the same desktop
  // app has a working bridge, while this session's host has none. The
  // sibling's subtree is pruned during the app-ancestor scan because its
  // disclaimer wrapper carries the sibling CLI's command.
  const verdict = classifyBridgePresence(
    claudeSessionRows({
      extraRows: [
        row(
          599,
          APP_PID,
          `/Applications/Claude.app/Contents/Helpers/disclaimer -- ${CLAUDE_CLI_COMMAND}`,
        ),
        row(600, 599, CLAUDE_CLI_COMMAND),
        row(
          601,
          600,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    }),
    HOOK_PID,
  );

  assert.equal(verdict.status, "absent");
});

test("softens absent to unknown when an unattributed app-level bridge exists", () => {
  // Observed live: the desktop app can attach a session's bridge to itself
  // through a disclaimer helper instead of the session's claude process.
  // Such a bridge cannot be attributed to one session, so it mutes the
  // warning rather than proving either verdict.
  const verdict = classifyBridgePresence(
    claudeSessionRows({
      extraRows: [
        row(
          700,
          APP_PID,
          "/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /bin/sh /plugins/recall/bridge/recall-node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
        row(
          701,
          700,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    }),
    HOOK_PID,
  );

  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.reason, "unattributed_app_level_bridge");
});

test("skips shell wrappers between the hook and the host", () => {
  // /opt/homebrew/bin/bash is the live regression: a shell outside /bin and
  // /usr/bin must still be skipped, or the walk stops at the wrong process.
  const rows = [
    row(HOST_PID, 1, "node /Users/x/.nvm/versions/node/bin/claude"),
    row(
      700,
      HOST_PID,
      "/opt/homebrew/bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot.sh && run-hook",
    ),
    row(701, 700, "/bin/sh /plugins/recall/bridge/recall-node /plugins/recall/hooks/journal-context.mjs"),
    row(HOOK_PID, 701, "node /plugins/recall/hooks/journal-context.mjs"),
    row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
  ];

  assert.equal(classifyBridgePresence(rows, HOOK_PID).status, "present");
});

test("stays unknown when the presumed host is not recognized", () => {
  // Neither a test runner nor the desktop app binary (capital Claude, no
  // lowercase claude CLI in its command) counts as a session host.
  for (const hostCommand of [
    "node /repo/tests/run-everything.mjs",
    "/Applications/Claude.app/Contents/MacOS/Claude",
  ]) {
    const rows = [
      row(HOST_PID, 1, hostCommand),
      row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
    ];
    const verdict = classifyBridgePresence(rows, HOOK_PID);

    assert.equal(verdict.status, "unknown", hostCommand);
    assert.equal(verdict.reason, "host_not_recognized", hostCommand);
  }
});

test("stays unknown without a table, a start row, or a host ancestor", () => {
  assert.equal(classifyBridgePresence(null, HOOK_PID).status, "unknown");
  assert.equal(classifyBridgePresence([], HOOK_PID).status, "unknown");
  assert.equal(
    classifyBridgePresence([row(1, 0, "/sbin/launchd")], HOOK_PID).reason,
    "start_process_not_listed",
  );

  const onlyWrappers = [
    row(1, 0, "/sbin/launchd"),
    row(400, 1, "/bin/sh some-wrapper"),
    row(HOOK_PID, 400, "node /plugins/recall/hooks/journal-context.mjs"),
  ];
  assert.equal(
    classifyBridgePresence(onlyWrappers, HOOK_PID).reason,
    "no_host_ancestor",
  );
});

test("never counts the start process's own subtree as the bridge", () => {
  const verdict = classifyBridgePresence(
    claudeSessionRows({
      extraRows: [
        row(901, HOOK_PID, "grep recall-mcp-bridge bridge/index.mjs"),
      ],
    }),
    HOOK_PID,
  );

  assert.equal(verdict.status, "absent");
});

test("caches a present verdict per session and reuses it", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  let reads = 0;
  const readTable = () => {
    reads += 1;
    return claudeSessionRows({
      bridgeRows: [
        row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
      ],
    });
  };

  const options = {
    readTable,
    sessionId: "session-abc",
    startPid: HOOK_PID,
    temporaryDirectory,
  };
  assert.equal(detectBridgeStatus(options).status, "present");
  assert.equal(detectBridgeStatus(options).status, "present");
  assert.equal(reads, 1);
  assert.equal(
    fs.existsSync(bridgeStatusCachePath("session-abc", temporaryDirectory)),
    true,
  );
});

test("re-walks an absent verdict so a late-started bridge is noticed", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  const tables = [
    claudeSessionRows(),
    claudeSessionRows({
      bridgeRows: [
        row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
      ],
    }),
  ];
  let reads = 0;
  const options = {
    readTable: () => tables[reads++],
    sessionId: "session-late",
    startPid: HOOK_PID,
    temporaryDirectory,
  };

  assert.equal(detectBridgeStatus(options).status, "absent");
  assert.equal(detectBridgeStatus(options).status, "present");
  assert.equal(reads, 2);
});

test("skips caching without a plain-token session id", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  let reads = 0;
  const readTable = () => {
    reads += 1;
    return claudeSessionRows({
      bridgeRows: [
        row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
      ],
    });
  };

  for (const sessionId of [null, "bad id", "../escape"]) {
    assert.equal(bridgeStatusCachePath(sessionId, temporaryDirectory), null);
    assert.equal(
      detectBridgeStatus({
        readTable,
        sessionId,
        startPid: HOOK_PID,
        temporaryDirectory,
      }).status,
      "present",
    );
  }
  assert.equal(reads, 3);
  assert.deepEqual(fs.readdirSync(temporaryDirectory), []);
});

test("ignores a corrupted or non-present cache entry", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  const cachePath = bridgeStatusCachePath("session-bad", temporaryDirectory);
  fs.writeFileSync(cachePath, "not json");

  let reads = 0;
  const verdict = detectBridgeStatus({
    readTable: () => {
      reads += 1;
      return claudeSessionRows();
    },
    sessionId: "session-bad",
    startPid: HOOK_PID,
    temporaryDirectory,
  });

  assert.equal(verdict.status, "absent");
  assert.equal(reads, 1);
  // An absent verdict is never cached, so the corrupt file is simply unused.
  assert.equal(fs.readFileSync(cachePath, "utf8"), "not json");
});

test("survives a throwing table reader", () => {
  const verdict = detectBridgeStatus({
    readTable: () => {
      throw new Error("ps unavailable");
    },
    sessionId: null,
    startPid: HOOK_PID,
    temporaryDirectory: makeTemporaryDirectory(),
  });

  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.reason, "process_walk_failed");
});
