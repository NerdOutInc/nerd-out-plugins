#!/usr/bin/env node
// Cross-platform launcher for the Recall MCP bridge — the successor to the
// POSIX-only `recall-node` script for the hosts' MCP configs. The configs
// invoke `node launch.mjs …` (Node.js 18+ on PATH is the one requirement the
// MCP ecosystem already assumes), and this shim picks the runtime the bridge
// itself should run under:
//
//   1. RECALL_BRIDGE_NODE — an explicit override for tests and repair. It must
//      be a Node executable; if it fails the version probe the launcher errors
//      loudly rather than silently falling back past an explicit choice.
//   2. Recall's pinned private runtime, when the Recall app has prepared it —
//      macOS:   ~/Library/Application Support/Recall/AgentRuntime/bin/recall-node
//      Windows: %LOCALAPPDATA%\NerdOut\Recall\AgentRuntime\bin\node.exe
//      (the Windows app's data root; the runtime ships in a future Recall for
//      Windows build, so the probe simply misses until then).
//   3. The runtime already executing this file, when it is Node 18+.
//
// The bridge (`index.mjs`) is then spawned with stdio inherited and its exit
// code forwarded verbatim, preserving the helper exit-code contract that
// index.mjs propagates (a Deny must reach the host as a refusal, never be
// reinterpreted here).
//
// `recall-node` remains alongside for the hook surfaces that run under a
// POSIX shell; both must keep selecting runtimes the same way.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const MINIMUM_NODE_MAJOR = 18;

function currentRuntimeIsSupported() {
  return Number(process.versions.node.split(".")[0]) >= MINIMUM_NODE_MAJOR;
}

// Mirrors recall-node's probe: ask the candidate itself, so a damaged or
// ancient runtime is skipped instead of crashing the bridge mid-handshake.
function runtimeIsSupported(executable) {
  const probe = spawnSync(
    executable,
    [
      "-e",
      `process.exit(Number(process.versions.node.split(".")[0]) >= ${MINIMUM_NODE_MAJOR} ? 0 : 1)`,
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
  return probe.status === 0;
}

function bundledRuntimeCandidate() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Recall",
      "AgentRuntime",
      "bin",
      "recall-node"
    );
  }
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(
      localAppData,
      "NerdOut",
      "Recall",
      "AgentRuntime",
      "bin",
      "node.exe"
    );
  }
  return null;
}

function fail(message) {
  process.stderr.write(`[recall] ${message}\n`);
  process.exit(1);
}

function resolveRuntime() {
  const override = process.env.RECALL_BRIDGE_NODE;
  if (override) {
    if (existsSync(override) && runtimeIsSupported(override)) return override;
    fail(
      `RECALL_BRIDGE_NODE (${override}) is not a working Node.js ` +
        `${MINIMUM_NODE_MAJOR}+ executable.`
    );
  }

  const bundled = bundledRuntimeCandidate();
  if (bundled && existsSync(bundled) && runtimeIsSupported(bundled)) {
    return bundled;
  }

  if (currentRuntimeIsSupported()) return process.execPath;

  fail(
    `Node.js ${MINIMUM_NODE_MAJOR} or newer is not available. Open Recall, ` +
      "then use Settings -> Integrations to prepare this agent, or install " +
      `Node.js ${MINIMUM_NODE_MAJOR}+.`
  );
}

const runtime = resolveRuntime();
const bridgeEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "index.mjs"
);

const child = spawn(runtime, [bridgeEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (error) => {
  fail(`Couldn't start the bridge runtime (${runtime}): ${error.message}`);
});

const signals =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
