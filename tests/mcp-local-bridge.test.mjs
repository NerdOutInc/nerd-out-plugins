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

/**
 * Run the bridge with a stubbed helper. Resolves once the process exits, or
 * once `waitForStderr` appears (the process is then killed) — the OAuth
 * fallback intentionally polls for the app for a minute, so a test that only
 * needs to observe the handoff watches stderr instead of waiting it out.
 */
function runBridge(helperPath, { waitForStderr, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, "--client-name", "Rig"], {
      env: {
        ...process.env,
        // Point at the stub; an absent/non-executable path makes the bridge
        // behave exactly as it does on a Mac with no socket-capable Recall.
        RECALL_MCP_BRIDGE: helperPath,
        // Never touch the developer's real OAuth cache: the fallback tests run
        // on machines where a production Recall is listening, so mcp-remote
        // would otherwise register a client and open a browser. They kill the
        // bridge at the transport marker, before it spawns the proxy, but the
        // redirect keeps that guarantee from depending on timing.
        MCP_REMOTE_CONFIG_DIR: path.join(path.dirname(helperPath), "mcp-auth"),
      },
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

test("a clean helper session propagates its exit code", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(directory, HELPER_EXIT.cleanEOF);

  const result = await runBridge(helper);

  assert.equal(result.code, 0);
});

test("a refused handshake surfaces the refusal and never falls back to OAuth", async (t) => {
  // The security-critical case: an auto-respawning MCP host must not turn one
  // Deny into an OAuth prompt storm, and a failed signature check must not be
  // papered over by the legacy path.
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.refused,
    'RECALL_BRIDGE_STATUS:{"status":"denied"}'
  );

  const result = await runBridge(helper);

  assert.equal(result.code, HELPER_EXIT.refused);
  assert.match(result.stderr, /"status":"denied"/);
  assert.doesNotMatch(result.stderr, /using OAuth/);
  assert.doesNotMatch(result.stderr, /Can't connect to the Recall MCP server/);
});

test("a protocol error surfaces instead of downgrading to OAuth", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(directory, HELPER_EXIT.protocolError);

  const result = await runBridge(helper);

  assert.equal(result.code, HELPER_EXIT.protocolError);
  assert.doesNotMatch(result.stderr, /using OAuth/);
});

test("an unsupported protocol version is the one ack that may use OAuth", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.unsupportedVersion
  );

  // Killing at the marker settles the test before the proxy is spawned, so it
  // never depends on (or disturbs) a Recall that happens to be running.
  const result = await runBridge(helper, {
    waitForStderr: "transport: oauth-http",
  });

  assert.equal(result.killed, true);
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

test("each session names the transport it chose", async (t) => {
  // Which path a session took is otherwise invisible — both speak identical
  // MCP stdio to the host — and it is the first question in any bridge
  // support thread (plan Phase 3 telemetry).
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(directory, HELPER_EXIT.cleanEOF);

  const result = await runBridge(helper);

  assert.match(result.stderr, /\[recall\] transport: local-socket/);
  assert.doesNotMatch(result.stderr, /transport: oauth-http/);
});

test("the bridge retries while the app is still launching", async (t) => {
  // `socketUnavailable` means Recall isn't up yet — the helper's own connect
  // already failed — so the supervisor keeps retrying rather than erroring on
  // the first attempt, preserving the old wait-for-app behavior.
  const directory = await mkdtemp(path.join(os.tmpdir(), "recall-bridge-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const helper = await writeFakeHelper(
    directory,
    HELPER_EXIT.socketUnavailable
  );

  const result = await runBridge(helper, {
    waitForStderr: "Waiting for the Recall Mac app",
  });

  assert.equal(result.killed, true);
  assert.doesNotMatch(result.stderr, /using OAuth/);
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
  assert.match(source, /unsupportedVersion[\s\S]{0,400}runOAuthFallback/);
});
