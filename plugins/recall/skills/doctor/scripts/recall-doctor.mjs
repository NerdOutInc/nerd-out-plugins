#!/usr/bin/env node
// Read-only diagnosis of the Recall MCP connection chain for the current
// agent session. Prints one JSON report; the doctor skill renders it for the
// user. Every check runs even after a failure so the report shows the whole
// chain, but the summary names the first broken link with its fix.
//
// The chain, in dependency order:
//   recall-app        — the Recall Mac app process exists
//   mcp-listener      — the loopback MCP listener answers (38473 release,
//                       38474 debug)
//   app-group-socket  — the app-group Unix socket the signed helper uses
//   session-bridge    — THIS session's host process has a bridge child
//   bridge-probe      — a freshly launched bridge answers JSON-RPC initialize
//   connection-logs   — the newest per-cwd Claude Code MCP log for the plugin

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLAUDE_HOST_COMMAND_PATTERN,
  classifyBridgePresence,
  readProcessTable,
} from "../../../hooks/bridge-detection.mjs";

const RELEASE_PORT = 38473;
const DEBUG_PORT = 38474;
const APP_GROUP_CONTAINER = "9Y4E2277K9.com.brianpattison.nerdout";
const SOCKET_NAMES = ["mcp.sock", "mcp.dev.sock"];
const APP_COMMAND_PATTERN = /Recall\.app\/Contents\/MacOS\/Recall/;
const TCP_PROBE_TIMEOUT_MS = 1_500;
const BRIDGE_PROBE_TIMEOUT_MS = 10_000;
const LOG_DIRECTORY_NAME = "mcp-logs-plugin-recall-recall";
const INITIALIZE_REQUEST_ID = 1;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "../../..");

// The signed helper's exit-code contract (see bridge/index.mjs HELPER_EXIT).
const HELPER_EXIT_EXPLANATIONS = {
  64: "the app-group socket was unavailable — Recall is not running or its MCP server is disabled",
  65: "the signed helper and the app share no MCP protocol version — update Recall",
  66: "Recall refused the connection (consent denied, revoked, or pending; signed out; or a different account) — approve this agent in Recall",
  70: "the signed helper hit a protocol error talking to Recall",
};

// Per-client host-process patterns for the session-bridge check. Claude Code
// is the mapped host today; the others are best-effort guesses that fail
// safe to "unknown" when they do not match.
const HOST_COMMAND_PATTERNS = {
  Claude: CLAUDE_HOST_COMMAND_PATTERN,
  Codex: /(?:^|[\s/])codex(?:\s|$)/i,
  Cursor: /(?:^|[\s/])cursor(?:\s|$)/i,
};

export function findRecallAppProcess(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => APP_COMMAND_PATTERN.test(row.command)) ?? null;
}

export function probeTcpPort(
  port,
  { host = "127.0.0.1", timeoutMs = TCP_PROBE_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function inspectAppGroupSockets(homeDirectory = os.homedir()) {
  const directory = path.join(
    homeDirectory,
    "Library",
    "Group Containers",
    APP_GROUP_CONTAINER,
  );
  return SOCKET_NAMES.map((name) => {
    const socketPath = path.join(directory, name);
    let present = false;
    try {
      present = fs.lstatSync(socketPath).isSocket();
    } catch {
      // Missing or unreadable counts as absent.
    }
    return { name, path: socketPath, present };
  });
}

// Claude Code keys its per-project caches by the working directory with every
// non-alphanumeric character flattened to "-".
export function logDirectorySlug(directory) {
  return directory.replace(/[^A-Za-z0-9-]/g, "-");
}

export function newestMcpLog({
  cwd = process.cwd(),
  homeDirectory = os.homedir(),
} = {}) {
  const directory = path.join(
    homeDirectory,
    "Library",
    "Caches",
    "claude-cli-nodejs",
    logDirectorySlug(path.resolve(cwd)),
    LOG_DIRECTORY_NAME,
  );
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return { directory, exists: false, fileCount: 0 };
  }

  let newest = null;
  let fileCount = 0;
  for (const name of names) {
    let stats;
    try {
      stats = fs.statSync(path.join(directory, name));
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    fileCount += 1;
    if (!newest || stats.mtimeMs > newest.modifiedAtMs) {
      newest = { name, modifiedAtMs: stats.mtimeMs };
    }
  }
  return {
    directory,
    exists: true,
    fileCount,
    ...(newest
      ? {
          newestFile: path.join(directory, newest.name),
          modifiedAt: new Date(newest.modifiedAtMs).toISOString(),
        }
      : {}),
  };
}

function compactText(value, limit = 400) {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, limit) || null;
}

// Launches the bridge exactly the way the host does and sends one JSON-RPC
// initialize. A response proves the whole app side of the chain end to end;
// a failure carries the exit code and stderr that explain which link broke.
export function probeBridgeInitialize({
  clientName = "Claude",
  command = "/bin/sh",
  args = [
    path.join(pluginRoot, "bridge", "recall-node"),
    path.join(pluginRoot, "bridge", "index.mjs"),
    "--client-name",
    clientName,
  ],
  timeoutMs = BRIDGE_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve(result);
    };

    const failure = (reason, extra = {}) =>
      finish({
        ok: false,
        reason,
        ...(compactText(stderrBuffer) ? { stderrTail: compactText(stderrBuffer) } : {}),
        ...extra,
      });

    const timer = setTimeout(
      () => failure("timeout", { timeoutMs }),
      timeoutMs,
    );

    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      failure("spawn_failed", { error: compactText(error?.message) });
      return;
    }
    child.once("error", (error) =>
      failure("spawn_failed", { error: compactText(error?.message) }),
    );
    child.once("exit", (code) =>
      failure("exited_before_responding", {
        exitCode: code,
        ...(HELPER_EXIT_EXPLANATIONS[code]
          ? { exitCodeMeaning: HELPER_EXIT_EXPLANATIONS[code] }
          : {}),
      }),
    );

    child.stderr.on("data", (chunk) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-4_096);
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== INITIALIZE_REQUEST_ID) continue;
        if (message.error) {
          failure("initialize_error", {
            error: compactText(message.error.message ?? JSON.stringify(message.error)),
          });
        } else {
          finish({
            ok: true,
            serverInfo: message.result?.serverInfo ?? null,
            protocolVersion: message.result?.protocolVersion ?? null,
          });
        }
        return;
      }
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: INITIALIZE_REQUEST_ID,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "recall-doctor", version: "1.0.0" },
          },
        })}\n`,
      );
    } catch (error) {
      failure("spawn_failed", { error: compactText(error?.message) });
    }
  });
}

// Pure assembly of the report from the raw check results, so tests can cover
// first-broken-link selection without touching the machine.
export function buildReport({
  clientName,
  appProcess,
  listener,
  sockets,
  sessionBridge,
  probe,
  logs,
}) {
  const socketPresent = sockets.some((socket) => socket.present);
  const listenerReachable = listener.release || listener.debug;

  const checks = [
    {
      name: "recall-app",
      ok: Boolean(appProcess),
      severity: "fail",
      detail: appProcess
        ? `Recall.app is running (pid ${appProcess.pid}).`
        : "No Recall.app process was found.",
      ...(appProcess ? {} : { fix: "Open Recall for Mac — the app is not running." }),
    },
    {
      name: "mcp-listener",
      ok: listenerReachable,
      severity: "fail",
      detail: listenerReachable
        ? `Loopback MCP listener reachable on port ${[
            listener.release ? RELEASE_PORT : null,
            listener.debug ? DEBUG_PORT : null,
          ]
            .filter(Boolean)
            .join(" and ")}.`
        : `Nothing is listening on 127.0.0.1:${RELEASE_PORT} (release) or :${DEBUG_PORT} (debug).`,
      ...(listenerReachable
        ? {}
        : {
            fix: "Recall's local MCP listener is unreachable: enable Settings -> MCP Server in Recall, then retry.",
          }),
    },
    {
      name: "app-group-socket",
      ok: socketPresent,
      // The signed-helper path needs the socket, but an older app still works
      // through OAuth against the loopback listener, so a missing socket
      // degrades rather than breaks the chain.
      severity: "warn",
      detail: sockets
        .map((socket) => `${socket.name}: ${socket.present ? "present" : "missing"}`)
        .join(", "),
      ...(socketPresent
        ? {}
        : {
            fix: "No app-group MCP socket exists. Update or restart Recall; older apps fall back to browser OAuth through the loopback listener.",
          }),
    },
    {
      name: "session-bridge",
      ok: sessionBridge.status === "present",
      severity: sessionBridge.status === "unknown" ? "warn" : "fail",
      detail:
        sessionBridge.status === "present"
          ? `This session's host process (pid ${sessionBridge.hostPid}) has a Recall bridge child (pid ${sessionBridge.bridgePid}).`
          : sessionBridge.status === "absent"
            ? `This session's host process (pid ${sessionBridge.hostPid}) has no Recall bridge child.`
            : `Could not identify this session's host process (${sessionBridge.reason}).`,
      ...(sessionBridge.status === "present"
        ? {}
        : sessionBridge.status === "absent"
          ? {
              fix: "The host never started the Recall connector for this chat even though the app side is up. Start a new session; if it recurs, re-enable the Recall plugin or connector for this client.",
            }
          : {
              fix: "Run the doctor from inside the agent session (its Bash tool) so the session's own host process is an ancestor of this check.",
            }),
    },
    {
      name: "bridge-probe",
      ok: probe.ok,
      severity: "fail",
      detail: probe.ok
        ? `A freshly launched bridge answered initialize: ${probe.serverInfo?.name ?? "unknown server"} ${probe.serverInfo?.version ?? ""}`.trim() +
          (probe.protocolVersion ? ` (protocol ${probe.protocolVersion}).` : ".")
        : `The bridge did not answer initialize (${probe.reason}${
            probe.exitCode !== undefined ? `, exit ${probe.exitCode}` : ""
          }).${probe.exitCodeMeaning ? ` Likely cause: ${probe.exitCodeMeaning}.` : ""}${
            probe.stderrTail ? ` stderr: ${probe.stderrTail}` : ""
          }`,
      ...(probe.ok
        ? {}
        : {
            fix:
              probe.exitCodeMeaning ??
              "The bridge itself cannot reach Recall. Check the detail's stderr, bring Recall forward, and approve any pending connection prompt.",
          }),
    },
    {
      name: "connection-logs",
      ok: Boolean(logs.exists && logs.newestFile),
      severity: "info",
      detail: logs.exists
        ? logs.newestFile
          ? `Newest connection log: ${logs.newestFile} (modified ${logs.modifiedAt}, ${logs.fileCount} file${logs.fileCount === 1 ? "" : "s"}).`
          : `Log directory exists but is empty: ${logs.directory}`
        : `No connection log directory exists for this working directory (${logs.directory}) — no connection attempt was ever logged here, consistent with the host never launching the connector.`,
    },
  ];

  const firstBroken =
    checks.find((check) => !check.ok && check.severity === "fail") ?? null;
  const warnings = checks.filter(
    (check) => !check.ok && check.severity === "warn",
  );

  return {
    clientName,
    pluginRoot,
    checks,
    firstBrokenLink: firstBroken?.name ?? null,
    summary: firstBroken
      ? `First broken link: ${firstBroken.name} — ${firstBroken.fix}`
      : `Recall connection chain looks healthy${
          probe.ok && probe.serverInfo
            ? ` (${probe.serverInfo.name} ${probe.serverInfo.version})`
            : ""
        }.${warnings.length > 0 ? ` Warnings: ${warnings.map((check) => check.name).join(", ")}.` : ""}`,
  };
}

export async function runDoctor({ clientName = "Claude" } = {}) {
  // The process table is read before the probe launches its own short-lived
  // bridge, so the probe can never satisfy the session-bridge check.
  const rows = readProcessTable();
  const sessionBridge = rows
    ? classifyBridgePresence(rows, process.pid, {
        hostCommandPattern:
          HOST_COMMAND_PATTERNS[clientName] ?? HOST_COMMAND_PATTERNS.Claude,
      })
    : { status: "unknown", reason: "no_process_table" };

  const [release, debug] = await Promise.all([
    probeTcpPort(RELEASE_PORT),
    probeTcpPort(DEBUG_PORT),
  ]);
  const probe = await probeBridgeInitialize({ clientName });

  return buildReport({
    clientName,
    appProcess: findRecallAppProcess(rows),
    listener: { release, debug },
    sockets: inspectAppGroupSockets(),
    sessionBridge,
    probe,
    logs: newestMcpLog(),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const args = process.argv.slice(2);
  const clientNameIndex = args.indexOf("--client-name");
  const clientName =
    clientNameIndex >= 0 ? (args[clientNameIndex + 1] ?? "Claude") : "Claude";
  const report = await runDoctor({ clientName });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
