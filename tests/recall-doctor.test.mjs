import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  findRecallAppProcess,
  logDirectorySlug,
  newestMcpLog,
  probeBridgeInitialize,
  probeTcpPort,
} from "../plugins/recall/skills/doctor/scripts/recall-doctor.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}

function healthyReportInput(overrides = {}) {
  return {
    clientName: "Claude",
    appProcess: {
      pid: 100,
      ppid: 1,
      command: "/Applications/Recall.app/Contents/MacOS/Recall",
    },
    listener: { release: true, debug: false },
    sockets: [
      { name: "mcp.sock", path: "/tmp/mcp.sock", present: true },
      { name: "mcp.dev.sock", path: "/tmp/mcp.dev.sock", present: false },
    ],
    sessionBridge: {
      status: "present",
      hostPid: 500,
      hostCommand: "claude",
      bridgePid: 502,
      bridgeCommand: "node bridge/index.mjs --client-name Claude",
    },
    probe: {
      ok: true,
      serverInfo: { name: "recall-local", version: "0.3.5" },
      protocolVersion: "2025-06-18",
    },
    logs: {
      directory: "/logs",
      exists: true,
      fileCount: 2,
      newestFile: "/logs/2026-08-27.txt",
      modifiedAt: "2026-08-27T15:00:00.000Z",
    },
    ...overrides,
  };
}

test("flattens a working directory the way Claude Code keys its caches", () => {
  assert.equal(
    logDirectorySlug(
      "/Users/brian/github/nerdoutinc/recall-plugins/.claude/worktrees/sharp-cohen-8ddb15",
    ),
    "-Users-brian-github-nerdoutinc-recall-plugins--claude-worktrees-sharp-cohen-8ddb15",
  );
});

test("finds the newest connection log for the working directory", () => {
  const home = makeTemporaryDirectory();
  const cwd = path.join(makeTemporaryDirectory(), "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const logDirectory = path.join(
    home,
    "Library",
    "Caches",
    "claude-cli-nodejs",
    logDirectorySlug(cwd),
    "mcp-logs-plugin-recall-recall",
  );
  fs.mkdirSync(logDirectory, { recursive: true });
  const older = path.join(logDirectory, "older.txt");
  const newer = path.join(logDirectory, "newer.txt");
  fs.writeFileSync(older, "old");
  fs.writeFileSync(newer, "new");
  fs.utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
  fs.utimesSync(newer, new Date(2026, 7, 27), new Date(2026, 7, 27));

  const result = newestMcpLog({ cwd, homeDirectory: home });
  assert.equal(result.exists, true);
  assert.equal(result.fileCount, 2);
  assert.equal(result.newestFile, newer);
});

test("reports a missing log directory as no connection ever attempted", () => {
  const result = newestMcpLog({
    cwd: path.join(makeTemporaryDirectory(), "repo"),
    homeDirectory: makeTemporaryDirectory(),
  });

  assert.equal(result.exists, false);
  assert.equal(result.fileCount, 0);
});

test("matches only the Recall.app binary as the app process", () => {
  const rows = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 2, ppid: 1, command: "node /repo/recall-plugins/bridge/index.mjs" },
    { pid: 3, ppid: 1, command: "/bin/sh recall-node something" },
    {
      pid: 4,
      ppid: 1,
      command:
        "/Users/x/DerivedData/Build/Products/Debug/Recall.app/Contents/MacOS/Recall",
    },
  ];

  assert.equal(findRecallAppProcess(rows)?.pid, 4);
  assert.equal(findRecallAppProcess(rows.slice(0, 3)), null);
  assert.equal(findRecallAppProcess(null), null);
});

test("a fully healthy chain has no broken link and names the server", () => {
  const report = buildReport(healthyReportInput());

  assert.equal(report.firstBrokenLink, null);
  assert.match(report.summary, /healthy/);
  assert.match(report.summary, /recall-local 0\.3\.5/);
  for (const check of report.checks) {
    assert.equal(check.ok, true, check.name);
  }
});

test("names the first broken link in dependency order", () => {
  const appDown = buildReport(
    healthyReportInput({
      appProcess: null,
      listener: { release: false, debug: false },
      probe: { ok: false, reason: "timeout" },
    }),
  );
  assert.equal(appDown.firstBrokenLink, "recall-app");
  assert.match(appDown.summary, /Open Recall for Mac/);

  const listenerDown = buildReport(
    healthyReportInput({
      listener: { release: false, debug: false },
      probe: { ok: false, reason: "timeout" },
    }),
  );
  assert.equal(listenerDown.firstBrokenLink, "mcp-listener");
  assert.match(listenerDown.summary, /Settings -> MCP Server/);
});

test("an absent session bridge with a healthy app side is the incident signature", () => {
  const report = buildReport(
    healthyReportInput({
      sessionBridge: { status: "absent", hostPid: 500, hostCommand: "claude" },
    }),
  );

  assert.equal(report.firstBrokenLink, "session-bridge");
  assert.match(report.summary, /never started the Recall connector/);
  assert.match(report.summary, /Start a new session/);
});

test("a missing socket alone is a warning, not a broken link", () => {
  const report = buildReport(
    healthyReportInput({
      sockets: [
        { name: "mcp.sock", path: "/tmp/mcp.sock", present: false },
        { name: "mcp.dev.sock", path: "/tmp/mcp.dev.sock", present: false },
      ],
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  assert.match(report.summary, /Warnings: app-group-socket/);
});

test("an unknown session bridge warns without breaking the chain", () => {
  const report = buildReport(
    healthyReportInput({
      sessionBridge: { status: "unknown", reason: "host_not_recognized" },
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  const check = report.checks.find((entry) => entry.name === "session-bridge");
  assert.equal(check.severity, "warn");
  assert.match(check.fix, /inside the agent session/);
});

test("surfaces the signed helper's exit-code meaning as the probe fix", () => {
  const report = buildReport(
    healthyReportInput({
      probe: {
        ok: false,
        reason: "exited_before_responding",
        exitCode: 66,
        exitCodeMeaning:
          "Recall refused the connection (consent denied, revoked, or pending; signed out; or a different account) — approve this agent in Recall",
      },
    }),
  );

  assert.equal(report.firstBrokenLink, "bridge-probe");
  assert.match(report.summary, /approve this agent in Recall/);
});

test("keeps the missing-log detail informational", () => {
  const report = buildReport(
    healthyReportInput({
      logs: { directory: "/logs", exists: false, fileCount: 0 },
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  const check = report.checks.find(
    (entry) => entry.name === "connection-logs",
  );
  assert.equal(check.ok, false);
  assert.equal(check.severity, "info");
  assert.match(check.detail, /no connection attempt was ever logged/);
});

test("probes a TCP listener honestly", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const openPort = server.address().port;

  assert.equal(await probeTcpPort(openPort), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeTcpPort(openPort), false);
});

test("reads serverInfo from a bridge that answers initialize", async () => {
  const stub = path.join(makeTemporaryDirectory(), "bridge-stub.mjs");
  fs.writeFileSync(
    stub,
    `
    process.stdin.once("data", () => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "recall-local", version: "9.9.9" },
        },
      }) + "\\n");
      setTimeout(() => {}, 60_000);
    });
    `,
  );

  const result = await probeBridgeInitialize({
    command: process.execPath,
    args: [stub],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.serverInfo, { name: "recall-local", version: "9.9.9" });
  assert.equal(result.protocolVersion, "2025-06-18");
});

test("maps a helper-contract exit into the probe failure", async () => {
  const stub = path.join(makeTemporaryDirectory(), "bridge-refused.mjs");
  fs.writeFileSync(
    stub,
    'process.stderr.write("connection refused by Recall\\n"); process.exit(66);',
  );

  const result = await probeBridgeInitialize({
    command: process.execPath,
    args: [stub],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "exited_before_responding");
  assert.equal(result.exitCode, 66);
  assert.match(result.exitCodeMeaning, /refused the connection/);
  assert.match(result.stderrTail, /connection refused/);
});

test("times out a bridge that never answers", async () => {
  const stub = path.join(makeTemporaryDirectory(), "bridge-silent.mjs");
  fs.writeFileSync(stub, "setTimeout(() => {}, 60_000);");

  const result = await probeBridgeInitialize({
    command: process.execPath,
    args: [stub],
    timeoutMs: 300,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});

test("ships the doctor entry points with the plugin", () => {
  const skillDirectory = path.join(
    repositoryRoot,
    "plugins/recall/skills/doctor",
  );
  assert.equal(fs.existsSync(path.join(skillDirectory, "SKILL.md")), true);
  const wrapper = path.join(skillDirectory, "scripts", "recall-doctor");
  assert.equal(fs.existsSync(wrapper), true);
  assert.notEqual(fs.statSync(wrapper).mode & 0o111, 0);
});
