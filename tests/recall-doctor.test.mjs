import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  bridgeProbeArguments,
  findRecallAppProcess,
  logDirectorySlug,
  newestMcpLog,
  parseDoctorArguments,
  probeBridgeInitialize,
  probeTcpPort,
  runDoctor,
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
    host: "claude-code",
    clientName: "Claude",
    sessionTools: "available",
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
    logEvidence: { readable: true },
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

test("reports a missing log directory without inferring connection history", () => {
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
  assert.equal(
    findRecallAppProcess([
      {
        pid: 9,
        ppid: 1,
        command:
          '/bin/bash -c "echo /Applications/Recall.app/Contents/MacOS/Recall"',
      },
      {
        pid: 10,
        ppid: 1,
        command:
          "node script.mjs /Applications/Recall.app/Contents/MacOS/Recall",
      },
    ]),
    null,
  );
});

test("separates reported current tools from a successful fresh initialize", () => {
  const report = buildReport(healthyReportInput());

  assert.equal(report.firstBrokenLink, null);
  assert.match(report.summary, /reported available/);
  assert.match(report.summary, /[Ff]resh/);
  assert.match(report.summary, /recall-local 0\.3\.5/);
  assert.match(report.summary, /not verify.*(tool call|journaling)/);
  assert.deepEqual(report.currentSessionTools, {
    status: "available",
    source: "caller_reported",
    scope: "current_conversation_read_tools",
  });
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

test("an absent bridge snapshot does not contradict reported current tools", () => {
  const report = buildReport(
    healthyReportInput({
      sessionBridge: { status: "absent", hostPid: 500, hostCommand: "claude" },
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  const check = report.checks.find((entry) => entry.name === "session-bridge");
  assert.equal(check.severity, "warn");
  assert.match(check.detail, /snapshot/);
  assert.doesNotMatch(report.summary, /never started|Start a new session/);
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
  assert.match(check.fix, /current conversation.*read tools/);
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
  const check = report.checks.find((entry) => entry.name === "connection-logs");
  assert.equal(check.ok, false);
  assert.equal(check.severity, "info");
  assert.match(check.detail, /does not prove.*(never|no connection)/);
});

test("a fresh probe cannot turn unknown current tool availability into success", () => {
  const report = buildReport(
    healthyReportInput({
      host: "codex",
      clientName: "Codex",
      sessionTools: "unknown",
      sessionBridge: {
        status: "unknown",
        reason: "shared_host_process",
        hostPid: 500,
        source: "process_snapshot",
      },
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  assert.equal(report.currentSessionTools.status, "unknown");
  assert.match(report.summary, /unverified/);
  assert.doesNotMatch(report.summary, /chain looks healthy/);
  const check = report.checks.find((entry) => entry.name === "session-bridge");
  assert.match(check.detail, /shared.*individual conversation/i);
});

test("missing read tools remain a failed current observation despite a fresh probe", () => {
  const report = buildReport(healthyReportInput({ sessionTools: "missing" }));

  assert.equal(report.firstBrokenLink, "current-session-tools");
  assert.match(report.summary, /current conversation/);
  assert.doesNotMatch(report.summary, /never started/);
});

test("a skipped fresh probe is informational, not a broken link", () => {
  const report = buildReport(
    healthyReportInput({
      probe: { ok: null, skipped: true, reason: "not_requested" },
    }),
  );

  assert.equal(report.firstBrokenLink, null);
  const check = report.checks.find((entry) => entry.name === "bridge-probe");
  assert.equal(check.status, "skipped");
  assert.equal(check.severity, "info");
  assert.match(check.detail, /--probe/);
  assert.doesNotMatch(report.summary, /initialize succeeded/);
});

test("the report never includes transient process argv", () => {
  const report = buildReport(
    healthyReportInput({
      sessionBridge: {
        status: "unknown",
        reason: "shared_host_process",
        hostPid: 500,
        hostCommand: "codex app-server --sensitive fixture-secret",
        bridgeCommand: "node bridge/index.mjs fixture-secret",
      },
    }),
  );

  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
});

test("resolves explicit hosts and preserves legacy client-name selection", () => {
  for (const [host, clientName] of [
    ["claude-code", "Claude"],
    ["codex", "Codex"],
    ["cursor", "Cursor"],
  ]) {
    assert.deepEqual(parseDoctorArguments(["--host", host]), {
      host,
      clientName,
      sessionTools: "unknown",
      probe: false,
      readConnectionLog: false,
    });
    assert.deepEqual(
      parseDoctorArguments(["--client-name", clientName]),
      parseDoctorArguments(["--host", host]),
    );
  }
  assert.deepEqual(parseDoctorArguments([]), {
    host: "claude-code",
    clientName: "Claude",
    sessionTools: "unknown",
    probe: false,
    readConnectionLog: false,
  });
  assert.deepEqual(
    parseDoctorArguments([
      "--host",
      "codex",
      "--client-name",
      "Codex",
      "--session-tools",
      "missing",
      "--probe",
    ]),
    {
      host: "codex",
      clientName: "Codex",
      sessionTools: "missing",
      probe: true,
      readConnectionLog: false,
    },
  );
});

test("rejects malformed or conflicting host selection instead of guessing Claude", () => {
  for (const args of [
    ["--host", "unknown"],
    ["--client-name", "Unknown"],
    ["--host", "codex", "--client-name", "Cursor"],
    ["--host"],
    ["--client-name"],
    ["--host", "--probe"],
    ["--session-tools", "connected"],
    ["--session-tools"],
    ["--host", "codex", "--host", "cursor"],
    ["--probe", "false"],
    ["--unknown"],
  ]) {
    assert.throws(
      () => parseDoctorArguments(args),
      /Invalid|Unknown|requires|Duplicate|match/,
    );
  }
});

function stubDoctorDependencies({ host = "codex", rows, probe, logs } = {}) {
  const events = [];
  const hostCommand =
    host === "codex"
      ? "/opt/codex app-server"
      : host === "cursor"
        ? "/Applications/Cursor.app/Contents/MacOS/Cursor"
        : "claude";
  return {
    events,
    dependencies: {
      startPid: 503,
      readTable: () => {
        events.push("snapshot");
        return (
          rows ?? [
            {
              pid: 100,
              ppid: 1,
              command: "/Applications/Recall.app/Contents/MacOS/Recall",
            },
            { pid: 500, ppid: 1, command: hostCommand },
            { pid: 502, ppid: 500, command: "/bin/bash" },
            { pid: 503, ppid: 502, command: "node recall-doctor.mjs" },
            {
              pid: 504,
              ppid: 500,
              command:
                "node /repo/recall-plugins/plugins/recall/bridge/index.mjs",
            },
          ]
        );
      },
      probeTcp: async (port) => {
        events.push(`tcp:${port}`);
        return port === 38473;
      },
      inspectSockets: () => healthyReportInput().sockets,
      readLogs: () => {
        events.push("logs");
        return logs ?? healthyReportInput().logs;
      },
      probeBridge: async (options) => {
        events.push({ probe: options });
        return probe ?? healthyReportInput().probe;
      },
    },
  };
}

test("the default doctor never starts a fresh bridge, and non-Claude logs stay unknown", async () => {
  for (const host of ["codex", "cursor"]) {
    const fixture = stubDoctorDependencies({ host });
    const report = await runDoctor({ host }, fixture.dependencies);

    assert.equal(report.host, host);
    assert.equal(report.currentSessionTools.status, "unknown");
    assert.equal(report.firstBrokenLink, null);
    assert.equal(
      fixture.events.some((event) => typeof event === "object"),
      false,
    );
    assert.equal(
      fixture.events.some(
        (event) => typeof event === "string" && event.startsWith("tcp:"),
      ),
      false,
    );
    assert.equal(fixture.events.includes("logs"), false);
    const bridge = report.checks.find(
      (check) => check.name === "session-bridge",
    );
    assert.equal(bridge.status, "unknown");
    assert.equal(bridge.reason, "shared_host_process");
    const logs = report.checks.find(
      (check) => check.name === "connection-logs",
    );
    assert.equal(logs.status, "unavailable");
    assert.doesNotMatch(logs.detail, /claude-cli-nodejs|no connection.*ever/i);
  }
});

test("unavailable process inspection stays unknown instead of reporting Recall stopped", async () => {
  const fixture = stubDoctorDependencies();
  fixture.dependencies.readTable = () => {
    throw new Error("unavailable");
  };
  const report = await runDoctor({ host: "codex" }, fixture.dependencies);

  assert.equal(report.firstBrokenLink, null);
  assert.equal(
    report.checks.find((check) => check.name === "recall-app").status,
    "unknown",
  );
  assert.equal(
    report.checks.find((check) => check.name === "session-bridge").status,
    "unknown",
  );
  assert.doesNotMatch(report.summary, /not running|Open Recall/);
});

test("invalid programmatic selection fails before any observation or connection", async () => {
  for (const options of [
    { host: "unsupported", probe: true },
    { host: "codex", clientName: "Cursor", probe: true },
    { host: "codex", sessionTools: "recording" },
    { host: "codex", probe: "false" },
  ]) {
    const fixture = stubDoctorDependencies();
    await assert.rejects(
      runDoctor(options, fixture.dependencies),
      /Invalid|match/,
    );
    assert.deepEqual(fixture.events, []);
  }
});

test("an explicitly requested probe uses the selected client after the process snapshot", async () => {
  for (const [host, clientName] of [
    ["claude-code", "Claude"],
    ["codex", "Codex"],
    ["cursor", "Cursor"],
  ]) {
    const fixture = stubDoctorDependencies({ host });
    await runDoctor(
      { host, probe: true, sessionTools: "available" },
      fixture.dependencies,
    );

    assert.equal(fixture.events[0], "snapshot");
    assert.deepEqual(
      fixture.events.find((event) => typeof event === "object"),
      { probe: { host, clientName } },
    );
    assert.equal(fixture.events.includes("logs"), host === "claude-code");
  }
});

test("fresh probes select the shipped host entrypoint without changing transport options", () => {
  for (const [host, clientName, adapter] of [
    ["claude-code", "Claude", true],
    ["codex", "Codex", true],
    ["cursor", "Cursor", false],
  ]) {
    const args = bridgeProbeArguments({ host });
    assert.equal(path.basename(args[0]), "recall-node");
    assert.equal(
      path.basename(args[1]),
      adapter ? "session-adapter.mjs" : "index.mjs",
    );
    assert.deepEqual(
      args.slice(2),
      adapter
        ? ["--host", host, "--client-name", clientName]
        : ["--client-name", clientName],
    );
  }
});

test("probes a TCP listener honestly", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const openPort = server.address().port;

  assert.equal(await probeTcpPort(openPort), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeTcpPort(openPort), false);
});

test(
  "reads serverInfo from a bridge that answers initialize",
  { skip: process.platform === "win32" },
  async () => {
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
    assert.deepEqual(result.serverInfo, {
      name: "recall-local",
      version: "9.9.9",
    });
    assert.equal(result.protocolVersion, "2025-06-18");
  },
);

test(
  "maps a helper-contract exit into the probe failure",
  { skip: process.platform === "win32" },
  async () => {
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
  },
);

test(
  "times out a bridge that never answers",
  { skip: process.platform === "win32" },
  async () => {
    const stub = path.join(makeTemporaryDirectory(), "bridge-silent.mjs");
    fs.writeFileSync(stub, "setTimeout(() => {}, 60_000);");

    const result = await probeBridgeInitialize({
      command: process.execPath,
      args: [stub],
      timeoutMs: 300,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
  },
);

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function runNestedProbeFixture(mode) {
  const directory = makeTemporaryDirectory();
  const treeScript = path.join(directory, "tree.mjs");
  const driverScript = path.join(directory, "driver.mjs");
  const pidLog = path.join(directory, "owned-pids.jsonl");
  fs.writeFileSync(
    treeScript,
    String.raw`
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    const [role, mode, pidLog] = process.argv.slice(2);
    fs.appendFileSync(pidLog, JSON.stringify({ role, pid: process.pid }) + "\n");
    setInterval(() => {}, 1_000);
    let child;
    process.on("SIGTERM", () => {
      // Force escalation on timeout while descendants still need cleanup.
      if (role === "parent" && mode === "timeout") return;
      if (!child || child.exitCode !== null) process.exit(0);
      else child.once("exit", () => process.exit(0));
    });
    if (role === "grandchild") {
      process.send({ ready: true });
    } else {
      child = spawn(process.execPath, [process.argv[1], role === "parent" ? "child" : "grandchild", mode, pidLog], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let ready = false;
      let requested = false;
      const respond = () => {
        if (!ready || !requested || role !== "parent") return;
        if (mode === "early-exit") process.exit(66);
        if (mode === "success") process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" } },
        }) + "\n");
      };
      child.once("message", () => {
        ready = true;
        if (role === "child") process.send({ ready: true });
        respond();
      });
      if (role === "parent") process.stdin.once("data", () => {
        requested = true;
        respond();
      });
    }
  `,
  );
  const doctorUrl = new URL(
    "../plugins/recall/skills/doctor/scripts/recall-doctor.mjs",
    import.meta.url,
  ).href;
  fs.writeFileSync(
    driverScript,
    `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    import { probeBridgeInitialize } from ${JSON.stringify(doctorUrl)};
    const [tree, mode, pidLog] = process.argv.slice(2);
    // This sibling belongs to the driver, not the probe's process group.
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.appendFileSync(pidLog, JSON.stringify({ role: "sentinel", pid: sentinel.pid }) + "\\n");
    const result = await probeBridgeInitialize({
      command: process.execPath,
      args: [tree, "parent", mode, pidLog],
      timeoutMs: mode === "timeout" ? 1_000 : 2_000,
    });
    const sentinelAlive = sentinel.exitCode === null && sentinel.signalCode === null;
    sentinel.kill("SIGKILL");
    process.stdout.write(JSON.stringify({ result, sentinelAlive }) + "\\n");
    // Do not force exit: inherited probe pipes must not hold this process open.
  `,
  );
  const driver = spawnSync(
    process.execPath,
    [driverScript, treeScript, mode, pidLog],
    {
      encoding: "utf8",
      detached: true,
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  const owned = fs.existsSync(pidLog)
    ? fs
        .readFileSync(pidLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  try {
    assert.equal(
      driver.error,
      undefined,
      `probe driver did not release its pipes: ${driver.error?.code}`,
    );
    assert.equal(driver.status, 0, driver.stderr);
    assert.deepEqual(owned.map((entry) => entry.role).sort(), [
      "child",
      "grandchild",
      "parent",
      "sentinel",
    ]);
    const report = JSON.parse(driver.stdout.trim());
    assert.equal(
      report.sentinelAlive,
      true,
      "probe cleanup must not signal its unrelated sibling",
    );
    for (const entry of owned) {
      assert.equal(
        processExists(entry.pid),
        false,
        `${entry.role} survived cleanup`,
      );
    }
    return report.result;
  } finally {
    // Red regressions must never leave the synthetic descendants behind.
    for (const { pid } of owned.reverse()) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
        continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
    if (Number.isSafeInteger(driver.pid) && driver.pid > 1) {
      try {
        process.kill(-driver.pid, "SIGKILL");
      } catch {
        /* Fixture group gone. */
      }
    }
  }
}

test(
  "a successful probe stops its nested descendants before returning",
  { skip: process.platform === "win32" },
  () => {
    const result = runNestedProbeFixture("success");
    assert.equal(result.ok, true);
    assert.equal(result.cleanup.status, "complete");
    assert.equal(result.cleanup.forced, false);
  },
);

test(
  "a timed-out probe escalates cleanup without orphaning descendants or pipes",
  { skip: process.platform === "win32" },
  () => {
    const result = runNestedProbeFixture("timeout");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.equal(result.cleanup.status, "complete");
    assert.equal(result.cleanup.forced, true);
  },
);

test(
  "a probe whose parent exits still stops its surviving descendants",
  { skip: process.platform === "win32" },
  () => {
    const result = runNestedProbeFixture("early-exit");
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 66);
    assert.equal(result.cleanup.status, "complete");
  },
);

test("an invalid probe host is rejected even when a custom command is supplied", () => {
  assert.throws(
    () =>
      probeBridgeInitialize({
        host: "unsupported",
        command: process.execPath,
        args: ["-e", "process.exit(99)"],
      }),
    /Invalid host/,
  );
});

test("a platform without process-group cleanup refuses the probe before spawning or signaling", () => {
  const directory = makeTemporaryDirectory();
  const script = path.join(directory, "unsupported-platform.mjs");
  const spawnMarker = path.join(directory, "spawned");
  const doctorUrl = new URL(
    "../plugins/recall/skills/doctor/scripts/recall-doctor.mjs",
    import.meta.url,
  ).href;
  fs.writeFileSync(
    script,
    `
    import { probeBridgeInitialize } from ${JSON.stringify(doctorUrl)};
    Object.defineProperty(process, "platform", { value: "win32" });
    process.kill = () => { throw new Error("must not signal any process"); };
    const result = await probeBridgeInitialize({
      command: process.execPath,
      args: ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned")`)}],
    });
    process.stdout.write(JSON.stringify(result));
  `,
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    reason: "probe_process_groups_unavailable",
  });
  assert.equal(fs.existsSync(spawnMarker), false);
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
