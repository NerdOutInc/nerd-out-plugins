import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  classifyBridgePresence,
  detectBridgeStatus,
  parseProcessTable,
  readProcessTable,
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

test("parses padded ps output and withholds a malformed or partial table", () => {
  const rows = parseProcessTable(
    "  1 0 /sbin/launchd\n" +
      "  500   1 /Applications/Claude.app/Contents/MacOS/Claude --flag value\n" +
      "\n",
  );

  assert.deepEqual(rows, [
    row(1, 0, "/sbin/launchd"),
    row(500, 1, "/Applications/Claude.app/Contents/MacOS/Claude --flag value"),
  ]);
  assert.equal(parseProcessTable(""), null);
  assert.equal(parseProcessTable(null), null);
  for (const suffix of [
    "not a process line",
    "2 1 ",
    "9007199254740992 1 claude",
  ])
    assert.equal(parseProcessTable(`1 0 /sbin/launchd\n${suffix}`), null);
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
        row(
          502,
          HOST_PID,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
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
    row(
      701,
      700,
      "/bin/sh /plugins/recall/bridge/recall-node /plugins/recall/hooks/journal-context.mjs",
    ),
    row(HOOK_PID, 701, "node /plugins/recall/hooks/journal-context.mjs"),
    row(
      502,
      HOST_PID,
      "node /plugins/recall/bridge/index.mjs --client-name Claude",
    ),
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
    assert.equal(
      verdict.reason,
      hostCommand.includes("MacOS/Claude")
        ? "shared_host_process"
        : "host_not_recognized",
      hostCommand,
    );
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

test("reads fresh evidence after bridge exit and restart without writing a cache", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  let reads = 0;
  const tables = [
    claudeSessionRows({
      bridgeRows: [
        row(
          502,
          HOST_PID,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    }),
    claudeSessionRows(),
    claudeSessionRows({
      bridgeRows: [
        row(
          503,
          HOST_PID,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    }),
  ];

  const options = {
    readTable: () => tables[reads++],
    sessionId: "session-abc",
    startPid: HOOK_PID,
    temporaryDirectory,
  };
  assert.equal(detectBridgeStatus(options).status, "present");
  assert.equal(detectBridgeStatus(options).status, "absent");
  assert.equal(detectBridgeStatus(options).bridgePid, 503);
  assert.equal(reads, 3);
  assert.deepEqual(fs.readdirSync(temporaryDirectory), []);
});

test("re-walks an absent verdict so a late-started bridge is noticed", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  const tables = [
    claudeSessionRows(),
    claudeSessionRows({
      bridgeRows: [
        row(
          502,
          HOST_PID,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
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

test("does not persist commands or use a session id as a filesystem path", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  let reads = 0;
  const readTable = () => {
    reads += 1;
    return claudeSessionRows({
      bridgeRows: [
        row(
          502,
          HOST_PID,
          "node /plugins/recall/bridge/index.mjs --client-name Claude",
        ),
      ],
    });
  };

  for (const sessionId of [null, "bad id", "../escape"]) {
    const verdict = detectBridgeStatus({
      readTable,
      sessionId,
      startPid: HOOK_PID,
      temporaryDirectory,
    });
    assert.equal(verdict.status, "present");
    assert.equal(verdict.source, "process_snapshot");
    assert.equal(verdict.hostCommand, undefined);
    assert.equal(verdict.bridgeCommand, undefined);
    assert.doesNotMatch(
      JSON.stringify(verdict),
      /plugins|client-name|Application Support/,
    );
  }
  assert.equal(reads, 3);
  assert.deepEqual(fs.readdirSync(temporaryDirectory), []);
});

test("ignores old positive cache entries instead of reviving an exited bridge", () => {
  const temporaryDirectory = makeTemporaryDirectory();
  const cachePath = path.join(
    temporaryDirectory,
    "recall-bridge-status-session-bad.json",
  );
  const oldCache = JSON.stringify({
    status: "present",
    hostPid: HOST_PID,
    bridgePid: 502,
  });
  fs.writeFileSync(cachePath, oldCache);

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
  assert.equal(fs.readFileSync(cachePath, "utf8"), oldCache);
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

test("distinguishes adapter startup from its actual bridge child", () => {
  const adapter = row(
    502,
    HOST_PID,
    "node /plugins/recall/bridge/session-adapter.mjs --host claude-code",
  );
  const rows = claudeSessionRows({ bridgeRows: [adapter] });
  assert.equal(classifyBridgePresence(rows, HOOK_PID).status, "absent");
  rows.push(
    row(503, 502, "node /plugins/recall/bridge/index.mjs --client-name Claude"),
  );
  assert.equal(classifyBridgePresence(rows, HOOK_PID).bridgePid, 503);
});

test("recognized Claude CLI launchers retain per-session detection", () => {
  for (const hostCommand of [
    "claude",
    "/Users/x/.local/bin/claude --output-format stream-json",
    "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "node /Users/x/.nvm/versions/node/bin/claude",
  ]) {
    const rows = [
      row(HOST_PID, 1, hostCommand),
      row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
    ];
    assert.equal(
      classifyBridgePresence(rows, HOOK_PID, { host: "claude-code" }).status,
      "absent",
    );
    rows.push(row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs"));
    assert.equal(
      classifyBridgePresence(rows, HOOK_PID, { host: "claude-code" }).status,
      "present",
    );
  }
});

test("requested host cannot adopt another agent's process boundary", () => {
  const rows = claudeSessionRows({
    bridgeRows: [row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs")],
  });
  for (const host of ["codex", "cursor", "anything-else"]) {
    assert.equal(
      classifyBridgePresence(rows, HOOK_PID, { host }).status,
      "unknown",
    );
  }
});

test("shared Codex and Cursor processes never prove this conversation's connector", () => {
  for (const [host, command] of [
    ["codex", "/Applications/Codex.app/Contents/Resources/codex app-server"],
    [
      "codex",
      "/opt/homebrew/bin/codex -c config=value app-server --listen stdio://",
    ],
    ["codex", "codex mcp-server"],
    ["codex", "codex --remote=ws://localhost:4321"],
    ["codex", "codex remote-control"],
    ["codex", "codex"],
    ["codex", "codex resume --last"],
    ["codex", "codex fork --last"],
    ["codex", "/Applications/Codex.app/Contents/MacOS/Codex"],
    ["cursor", "/Applications/Cursor.app/Contents/MacOS/Cursor"],
    [
      "cursor",
      "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility",
    ],
  ]) {
    const rows = [
      row(HOST_PID, 1, command),
      row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
    ];
    for (const bridgePresent of [false, true]) {
      if (bridgePresent)
        rows.push(row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs"));
      const result = classifyBridgePresence(rows, HOOK_PID, { host });
      assert.equal(result.status, "unknown", command + ": " + bridgePresent);
      assert.equal(result.reason, "shared_host_process", command);
      assert.equal(result.bridgePid, undefined);
    }
  }
});

test("unverified Codex exec and branded Cursor CLI boundaries stay unknown", () => {
  for (const [host, command] of [
    ["codex", "/opt/homebrew/bin/codex exec --json"],
    ["codex", "codex e --json"],
    [
      "cursor",
      "/Users/x/.local/share/cursor-agent/versions/2026.08.25-example/cursor-agent --print",
    ],
  ]) {
    const rows = [
      row(HOST_PID, 1, command),
      row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
      row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs"),
    ];
    const result = classifyBridgePresence(rows, HOOK_PID, { host });
    assert.equal(result.status, "unknown", command);
    assert.equal(result.reason, "unverified_cli_boundary", command);
  }
});

test("generic agent, node, and host names in arguments do not identify a session", () => {
  for (const [host, command] of [
    ["cursor", "agent --print"],
    ["cursor", "/Users/x/.grok/bin/agent"],
    ["cursor", "cursor-agent"],
    ["cursor", "node /tmp/agent.js"],
    ["codex", "node /repo/test.mjs codex"],
    [
      "codex",
      "node /repo/test.mjs /Applications/Codex.app/Contents/Resources/codex",
    ],
    ["claude-code", "node /repo/test.mjs --prompt claude"],
  ]) {
    const rows = [
      row(HOST_PID, 1, command),
      row(HOOK_PID, HOST_PID, "node /plugins/recall/hooks/journal-context.mjs"),
      row(502, HOST_PID, "node /plugins/recall/bridge/index.mjs"),
    ];
    assert.equal(
      classifyBridgePresence(rows, HOOK_PID, { host }).reason,
      "host_not_recognized",
      command,
    );
  }
});

test("nested or sibling runs from any recognized host cannot supply the bridge", () => {
  for (const command of [
    CLAUDE_CLI_COMMAND,
    "codex",
    "codex app-server",
    "/Applications/Cursor.app/Contents/MacOS/Cursor",
    "/Users/x/.local/share/cursor-agent/versions/example/cursor-agent",
  ]) {
    for (const parent of [HOST_PID, APP_PID]) {
      const rows = claudeSessionRows({
        extraRows: [
          row(600, parent, command),
          row(601, 600, "node /plugins/recall/bridge/index.mjs"),
        ],
      });
      assert.equal(
        classifyBridgePresence(rows, HOOK_PID).status,
        "absent",
        command + ": " + parent,
      );
    }
  }
});

test("bridge names inside unrelated commands are not bridge processes", () => {
  const rows = claudeSessionRows({
    extraRows: [
      row(502, HOST_PID, "grep recall-mcp-bridge bridge/index.mjs"),
      row(
        503,
        HOST_PID,
        "node /repo/test.mjs /plugins/recall/bridge/index.mjs",
      ),
      row(504, HOST_PID, "node /repo/test.mjs --script recall-mcp-bridge"),
      row(505, HOST_PID, "node /plugins/unrelated/bridge/index.mjs"),
    ],
  });
  assert.equal(classifyBridgePresence(rows, HOOK_PID).status, "absent");
});

test("bounded walks cannot report absence from malformed, cyclic, or oversized evidence", () => {
  const malformedTables = [
    [...claudeSessionRows(), row(HOST_PID, 1, "claude")],
    [...claudeSessionRows(), row(600, -1, "node server.mjs")],
    [...claudeSessionRows(), row(600, HOST_PID, "private\ncommand")],
    [
      row(HOOK_PID, 700, "node hook.mjs"),
      row(700, 701, "/bin/sh hook"),
      row(701, 700, "/bin/sh hook"),
    ],
  ];
  for (const rows of malformedTables)
    assert.equal(
      classifyBridgePresence(rows, HOOK_PID).reason,
      "invalid_process_table",
    );

  const largeSubtree = Array.from({ length: 4_097 }, (_, index) =>
    row(10_000 + index, HOST_PID, "node unrelated.mjs"),
  );
  assert.equal(
    classifyBridgePresence(
      claudeSessionRows({ extraRows: largeSubtree }),
      HOOK_PID,
    ).reason,
    "process_scan_limit",
  );
  assert.equal(
    classifyBridgePresence(
      Array.from({ length: 16_385 }, (_, index) => row(index + 1, 0, "x")),
      HOOK_PID,
    ).reason,
    "process_scan_limit",
  );
});

test("process reading is bounded, noninteractive, and treats failures as unknown", () => {
  let reads = 0;
  assert.deepEqual(
    readProcessTable((command, args, options) => {
      reads++;
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-axww", "-o", "pid=,ppid=,command="]);
      assert.equal(options.timeout, 1_500);
      assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
      return { status: 0, stdout: "1 0 /sbin/launchd\n" };
    }),
    [row(1, 0, "/sbin/launchd")],
  );
  assert.equal(reads, 1);
  for (const result of [
    { status: 1, stdout: "" },
    { status: null, error: new Error("timeout") },
  ])
    assert.equal(
      readProcessTable(() => result),
      null,
    );
});

test("a bridge behind an unknown nested owner cannot establish the parent's connector", () => {
  for (const command of [
    "/Users/x/.grok/bin/agent",
    "/Users/x/.local/bin/cursor-agent",
    "node /tools/unknown-agent.mjs",
  ]) {
    const rows = claudeSessionRows({
      extraRows: [
        row(600, HOST_PID, command),
        row(601, 600, "node /plugins/recall/bridge/session-adapter.mjs"),
        row(602, 601, "node /plugins/recall/bridge/index.mjs"),
      ],
    });
    const result = classifyBridgePresence(rows, HOOK_PID);
    assert.equal(result.status, "unknown", command);
    assert.equal(result.reason, "unattributed_descendant_bridge", command);
  }
});

test("an independently attributable bridge wins over an unknown owner's bridge", () => {
  const rows = claudeSessionRows({
    extraRows: [
      row(600, HOST_PID, "/Users/x/.grok/bin/agent"),
      row(601, 600, "node /plugins/recall/bridge/index.mjs"),
      row(700, HOST_PID, "/bin/sh /plugins/recall/bridge/recall-node"),
      row(701, 700, "node /plugins/recall/bridge/session-adapter.mjs"),
      row(702, 701, "node /plugins/recall/bridge/index.mjs"),
    ],
  });
  const result = classifyBridgePresence(rows, HOOK_PID);
  assert.equal(result.status, "present");
  assert.equal(result.bridgePid, 702);
});

test("unknown nonbridge subtrees do not manufacture connector uncertainty", () => {
  const rows = claudeSessionRows({
    extraRows: [
      row(600, HOST_PID, "/Users/x/.local/bin/cursor-agent"),
      row(601, 600, "node /plugins/other/server.mjs"),
      row(602, 601, "node /tools/worker.mjs"),
    ],
  });
  assert.equal(classifyBridgePresence(rows, HOOK_PID).status, "absent");
});

test("known shell, Recall adapter, and desktop launch wrappers retain attribution", () => {
  for (const command of [
    "/bin/sh /plugins/recall/bridge/recall-node",
    "/opt/homebrew/bin/bash -c run-recall",
    "node /plugins/recall/bridge/session-adapter.mjs",
    "/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /bin/sh",
  ]) {
    const rows = claudeSessionRows({
      extraRows: [
        row(600, HOST_PID, command),
        row(601, 600, "node /plugins/recall/bridge/index.mjs"),
      ],
    });
    const result = classifyBridgePresence(rows, HOOK_PID);
    assert.equal(result.status, "present", command);
    assert.equal(result.bridgePid, 601, command);
  }
});
