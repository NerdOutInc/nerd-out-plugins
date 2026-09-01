import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const bridgePath = new URL("plugins/recall/bridge/index.mjs", repoRoot)
  .pathname;

// The helper's exit-code contract, mirrored from recall-app's
// apple-app/McpBridgeSources/main.swift. These values are the whole
// fallback-classification policy, so the tests below pin each one.
const HELPER_EXIT = {
  cleanEOF: 0,
  socketUnavailable: 64,
  unsupportedVersion: 65,
  refused: 66,
  protocolError: 70,
};

/** A stand-in for the Recall-signed helper that exits with a fixed code. */
async function writeFakeHelper(directory, exitCode, stderrLine = "") {
  const helperPath = path.join(directory, "recall-mcp-bridge");
  const emit = stderrLine
    ? `printf '%s\\n' ${JSON.stringify(stderrLine)} >&2\n`
    : "";
  await writeFile(helperPath, `#!/bin/sh\n${emit}exit ${exitCode}\n`);
  await chmod(helperPath, 0o755);
  return helperPath;
}

// A stand-in for the helper AFTER an ok ack: a minimal NDJSON MCP server that
// answers initialize/tools/list and stays alive until EOF, exactly like the
// real helper pumping bytes to the app.
const PUMP_SOURCE = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize" && msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "recall-fake", version: "1" },
    } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list" && msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: "fake_tool", inputSchema: { type: "object" } }],
    } }) + "\\n");
    return;
  }
  if (msg.id !== undefined && msg.method !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
rl.on("close", () => process.exit(0));
`;

/**
 * A helper that refuses (like a signed-out app) until `flagPath` exists, then
 * behaves as a live pump — the shape of the 2026-09-01 incident's recovery.
 */
async function writeSwitchingHelper(directory, flagPath) {
  const pumpPath = path.join(directory, "pump.mjs");
  await writeFile(pumpPath, PUMP_SOURCE);
  const helperPath = path.join(directory, "recall-mcp-bridge");
  await writeFile(
    helperPath,
    [
      "#!/bin/sh",
      `if [ -e ${JSON.stringify(flagPath)} ]; then`,
      `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(pumpPath)}`,
      "fi",
      `printf '%s\\n' 'RECALL_BRIDGE_STATUS:{"message":"Sign in to Recall, then try again.","status":"signed_out"}' >&2`,
      `exit ${HELPER_EXIT.refused}`,
      "",
    ].join("\n")
  );
  await chmod(helperPath, 0o755);
  return helperPath;
}

/** A helper that is always a live pump. */
async function writePumpHelper(directory) {
  const pumpPath = path.join(directory, "pump.mjs");
  await writeFile(pumpPath, PUMP_SOURCE);
  const helperPath = path.join(directory, "recall-mcp-bridge");
  await writeFile(
    helperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(pumpPath)}\n`
  );
  await chmod(helperPath, 0o755);
  return helperPath;
}

function bridgeEnv(helperPath) {
  return {
    ...process.env,
    // Point at the stub; an absent/non-executable path makes the bridge
    // behave exactly as it does on a Mac with no socket-capable Recall.
    RECALL_MCP_BRIDGE: helperPath,
    // Fast holds/retries so resilience tests settle quickly. The hold stays
    // comfortably above a cold Node start so a live fake helper wins the race
    // against the bridge's local degraded answer.
    RECALL_BRIDGE_HOLD_MS: "2000",
    RECALL_BRIDGE_RETRY_MIN_MS: "50",
    RECALL_BRIDGE_RETRY_MAX_MS: "200",
    // Never touch the developer's real OAuth cache: the fallback tests run
    // on machines where a production Recall is listening, so mcp-remote
    // would otherwise register a client and open a browser. They kill the
    // bridge at the transport marker, before it spawns the proxy, but the
    // redirect keeps that guarantee from depending on timing.
    MCP_REMOTE_CONFIG_DIR: path.join(path.dirname(helperPath), "mcp-auth"),
    CLAUDE_CONFIG_DIR: path.join(path.dirname(helperPath), "claude-config"),
    CODEX_HOME: path.join(path.dirname(helperPath), "codex-config"),
  };
}

/**
 * Run the bridge and drive it as an MCP host: send JSON-RPC lines on stdin,
 * await matching stdout lines / stderr markers, then close stdin and await
 * the exit code.
 */
function startBridge(helperPath, { adapterHost } = {}) {
  const entry = adapterHost
    ? [
        new URL("plugins/recall/bridge/session-adapter.mjs", repoRoot).pathname,
        "--host",
        adapterHost,
      ]
    : [bridgePath];
  const child = spawn(
    process.execPath,
    [...entry, "--client-name", "Rig"],
    { env: bridgeEnv(helperPath), stdio: ["pipe", "pipe", "pipe"] }
  );

  const state = {
    child,
    stderr: "",
    stdoutLines: [],
    stdoutWaiters: [],
    exit: new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    }),
  };

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let index;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // non-JSON stdout is unexpected; surface it to waiters as raw
      }
      state.stdoutLines.push(parsed ?? line);
      for (const waiter of [...state.stdoutWaiters]) {
        if (waiter.predicate(parsed ?? line)) {
          state.stdoutWaiters.splice(state.stdoutWaiters.indexOf(waiter), 1);
          waiter.resolve(parsed ?? line);
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
    for (const waiter of [...(state.stderrWaiters ?? [])]) {
      if (state.stderr.includes(waiter.needle)) {
        state.stderrWaiters.splice(state.stderrWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  state.stderrWaiters = [];

  state.send = (value) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  state.expectStdout = (predicate, label, timeoutMs = 10_000) => {
    const existing = state.stdoutLines.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `did not see ${label} in ${timeoutMs}ms; stderr: ${state.stderr}`
          )
        );
      }, timeoutMs);
      state.stdoutWaiters.push({
        predicate,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  };
  state.expectStderr = (needle, timeoutMs = 10_000) => {
    if (state.stderr.includes(needle)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`did not see "${needle}" in stderr; got: ${state.stderr}`)
        );
      }, timeoutMs);
      state.stderrWaiters.push({
        needle,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  };
  state.stop = async () => {
    child.stdin.end();
    const code = await Promise.race([
      state.exit,
      new Promise((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve("killed");
        }, 5_000)
      ),
    ]);
    return code;
  };
  return state;
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "rig", version: "0" },
  },
};

/**
 * Legacy-style runner for the OAuth fallback tests: resolves on exit or once
 * `waitForStderr` appears (the process is then killed) — the OAuth fallback
 * intentionally polls for the app for a minute, so a test that only needs to
 * observe the handoff watches stderr instead of waiting it out.
 */
function runBridge(helperPath, { waitForStderr, timeoutMs = 15_000, adapterHost } = {}) {
  return new Promise((resolve, reject) => {
    const entry = adapterHost ? [new URL("plugins/recall/bridge/session-adapter.mjs", repoRoot).pathname, "--host", adapterHost] : [bridgePath];
    const child = spawn(process.execPath, [...entry, "--client-name", "Rig"], {
      env: bridgeEnv(helperPath),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bridge did not settle in ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (waitForStderr && stderr.includes(waitForStderr)) {
        child.kill("SIGKILL");
        finish({ code: null, killed: true, stderr });
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => finish({ code, killed: false, stderr }));
  });
}

test("a live helper serves the handshake and exits cleanly on host EOF", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writePumpHelper(directory);

  const bridge = startBridge(helper);
  bridge.send(initializeRequest);
  const response = await bridge.expectStdout(
    (line) => line?.id === 1 && line?.result,
    "initialize response"
  );
  // The app's own handshake answered — not the bridge's degraded stand-in.
  assert.equal(response.result.serverInfo.name, "recall-fake");
  assert.match(bridge.stderr, /\[recall\] transport: local-socket/);
  assert.doesNotMatch(bridge.stderr, /transport: oauth-http/);

  assert.equal(await bridge.stop(), 0);
});

test("a refused handshake degrades instead of dying and never falls back to OAuth", async (t) => {
  // The 2026-09-01 incident: one signed_out refusal used to kill the process,
  // so the MCP host marked the server failed for the whole conversation. The
  // bridge must stay up, answer initialize itself, and surface the bounded
  // status message on tool calls — and a Deny must never become an OAuth
  // prompt storm.
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.refused,
    'RECALL_BRIDGE_STATUS:{"message":"MCP access was denied in Recall. Allow it again under Settings.","status":"denied"}'
  );

  const bridge = startBridge(helper);
  bridge.send(initializeRequest);
  const response = await bridge.expectStdout(
    (line) => line?.id === 1 && line?.result,
    "degraded initialize response"
  );
  assert.equal(response.result.capabilities.tools.listChanged, true);
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  bridge.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_notes", arguments: {} },
  });
  const error = await bridge.expectStdout(
    (line) => line?.id === 2 && line?.error,
    "degraded tools/call error"
  );
  assert.match(error.error.message, /denied/);
  assert.match(error.error.message, /MCP access was denied in Recall/);
  assert.match(error.error.message, /retries automatically/);

  await bridge.expectStderr('"status":"denied"');
  await bridge.expectStderr("bridge degraded (denied)");
  assert.doesNotMatch(bridge.stderr, /using OAuth/);
  assert.doesNotMatch(bridge.stderr, /Can't connect to the Recall MCP server/);

  assert.equal(await bridge.stop(), 0);
});

test("tools recover in the same conversation once Recall stops refusing", async (t) => {
  // The acceptance test for bridge self-healing: refuse the hello (signed
  // out), sign back in, and the SAME bridge process reconnects, replays the
  // handshake, and tells the host the tool list changed — no client restart.
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const flagPath = path.join(directory, "signed-in");
  const helper = await writeSwitchingHelper(directory, flagPath);

  const bridge = startBridge(helper);
  bridge.send(initializeRequest);
  await bridge.expectStdout(
    (line) => line?.id === 1 && line?.result,
    "initialize response"
  );
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await bridge.expectStderr("bridge degraded (signed_out)");

  // The user signs in.
  await writeFile(flagPath, "");

  await bridge.expectStdout(
    (line) => line?.method === "notifications/tools/list_changed",
    "tools/list_changed after reconnect"
  );
  await bridge.expectStderr("reconnected to Recall");

  bridge.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const listed = await bridge.expectStdout(
    (line) => line?.id === 3 && line?.result,
    "tools/list from the live app"
  );
  assert.equal(listed.result.tools[0].name, "fake_tool");
  assert.doesNotMatch(bridge.stderr, /using OAuth/);

  assert.equal(await bridge.stop(), 0);
});

test("a connection dropped mid-conversation fails in-flight calls and re-dials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  // A pump that dies right after the handshake (like a sign-out closing the
  // socket), then keeps refusing: the bridge must stay alive and degrade.
  const pumpPath = path.join(directory, "pump.mjs");
  await writeFile(
    pumpPath,
    PUMP_SOURCE.replace(
      'rl.on("close", () => process.exit(0));',
      'rl.on("close", () => process.exit(0));\nsetTimeout(() => process.exit(0), 300);'
    )
  );
  const helperPath = path.join(directory, "recall-mcp-bridge");
  const onceFlag = path.join(directory, "first-connect-done");
  await writeFile(
    helperPath,
    [
      "#!/bin/sh",
      `if [ -e ${JSON.stringify(onceFlag)} ]; then`,
      `  printf '%s\\n' 'RECALL_BRIDGE_STATUS:{"message":"Sign in to Recall, then try again.","status":"signed_out"}' >&2`,
      `  exit ${HELPER_EXIT.refused}`,
      "fi",
      `touch ${JSON.stringify(onceFlag)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(pumpPath)}`,
      "",
    ].join("\n")
  );
  await chmod(helperPath, 0o755);

  const bridge = startBridge(helperPath);
  bridge.send(initializeRequest);
  await bridge.expectStdout(
    (line) => line?.id === 1 && line?.result,
    "initialize response"
  );
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // The pump exits ~300ms after connecting; the bridge must degrade, not die.
  await bridge.expectStderr("bridge degraded (signed_out)");
  bridge.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "list_notes", arguments: {} },
  });
  const error = await bridge.expectStdout(
    (line) => line?.id === 9 && line?.error,
    "degraded error after drop"
  );
  assert.match(error.error.message, /Sign in to Recall/);

  assert.equal(await bridge.stop(), 0);
});

test("the lifecycle wrapper rides the resilient bridge without OAuth downgrades", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-adapter-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  for (const adapterHost of ["claude-code", "codex"]) {
    const helper = await writeFakeHelper(
      directory,
      HELPER_EXIT.refused,
      'RECALL_BRIDGE_STATUS:{"status":"signed_out"}'
    );
    const bridge = startBridge(helper, { adapterHost });
    bridge.send(initializeRequest);
    await bridge.expectStdout(
      (line) => line?.id === 1 && line?.result,
      `degraded initialize via ${adapterHost} adapter`
    );
    assert.doesNotMatch(bridge.stderr, /using OAuth/);
    const code = await bridge.stop();
    assert.equal(code, 0);
  }
});

test("an unsupported protocol version is the one ack that may use OAuth", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.unsupportedVersion
  );

  // Killing at the marker settles the test before the proxy is spawned, so it
  // never depends on (or disturbs) a Recall that happens to be running. The
  // fallback needs the host's opening request to trigger the first attempt.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, "--client-name", "Rig"], {
      env: bridgeEnv(helper),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no OAuth marker in time: ${stderr}`));
    }, 15_000);
    child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("transport: oauth-http")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve({ stderr });
      }
    });
    child.on("error", reject);
  });

  assert.match(result.stderr, /older than this plugin; using OAuth/);
  assert.match(result.stderr, /transport: local-socket/);
});

test("no installed helper falls back to the legacy OAuth path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const result = await runBridge(path.join(directory, "does-not-exist"), {
    waitForStderr: "transport: oauth-http",
  });

  assert.equal(result.killed, true);
  assert.doesNotMatch(result.stderr, /transport: local-socket/);
});

test("the bridge retries while the app is still launching", async (t) => {
  // `socketUnavailable` means Recall isn't up yet — the helper's own connect
  // already failed — so the supervisor keeps re-dialing rather than erroring,
  // preserving the old wait-for-app behavior without its 60-second give-up.
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.socketUnavailable
  );

  const bridge = startBridge(helper);
  bridge.send(initializeRequest);
  await bridge.expectStderr("Waiting for the Recall Mac app");
  assert.doesNotMatch(bridge.stderr, /using OAuth/);
  assert.equal(await bridge.stop(), 0);
});

test("the bridge source keeps the fallback classification explicit", async () => {
  const source = await readFile(
    new URL("plugins/recall/bridge/index.mjs", repoRoot),
    "utf8"
  );

  // The exit-code table is a cross-repo contract with the Recall app's helper.
  for (const [name, code] of Object.entries(HELPER_EXIT)) {
    assert.match(
      source,
      new RegExp(`${name}:\\s*${code}`),
      `bridge is missing the ${name} (${code}) exit code`
    );
  }
  // Only the unsupported-version branch may reach the OAuth fallback.
  assert.match(source, /unsupportedVersion[\s\S]{0,700}handOffToOAuth/);
  assert.match(source, /handOffToOAuth\(\) \{[\s\S]{0,1400}runOAuthFallback/);
});
