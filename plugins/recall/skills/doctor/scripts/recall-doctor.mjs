#!/usr/bin/env node
// Passive diagnosis of the Recall MCP connection chain. The current caller's
// read-tool inventory, a bounded process snapshot, and an optional new
// connection are separate observations; none certifies session recording.
// --probe explicitly opts into TCP and initialize probes that may prompt for
// consent. Without it this script never starts a bridge or opens a connection.
//
// The chain, in dependency order:
//   recall-app        — the Recall Mac app process exists
//   mcp-listener      — the loopback MCP listener answers (38473 release,
//                       38474 debug)
//   app-group-socket  — the app-group Unix socket the signed helper uses
//   session-bridge    — advisory process ancestry, unknown for shared hosts
//   current-session-tools — caller-reported Recall read-tool availability
//   bridge-probe      — a NEW bridge answers initialize, only with --probe
//   connection-logs   — Claude Code log metadata, unverified for other hosts
//   last-refusal      — the newest log body’s last helper refusal, only with
//                       --read-connection-log (consent-gated)

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyBridgePresence,
  readProcessTable,
} from "../../../hooks/bridge-detection.mjs";

const RELEASE_PORT = 38473;
const DEBUG_PORT = 38474;
const APP_GROUP_CONTAINER = "9Y4E2277K9.com.brianpattison.nerdout";
const SOCKET_NAMES = ["mcp.sock", "mcp.dev.sock"];
// Match the executable position, not an app path mentioned in a shell prompt.
const APP_COMMAND_PATTERN =
  /^(?:"[^"\r\n]*\/Recall\.app\/Contents\/MacOS\/Recall"|'[^'\r\n]*\/Recall\.app\/Contents\/MacOS\/Recall'|\/[^\s]*\/Recall\.app\/Contents\/MacOS\/Recall)(?:\s|$)/;
const TCP_PROBE_TIMEOUT_MS = 1_500;
const BRIDGE_PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 250;
const PROBE_FORCE_STOP_WAIT_MS = 750;
const PROBE_CLEANUP_POLL_MS = 20;
const LOG_DIRECTORY_NAME = "mcp-logs-plugin-recall-recall";
const INITIALIZE_REQUEST_ID = 1;
const CLIENT_NAMES = Object.freeze({
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
});
const SESSION_TOOL_STATES = ["available", "missing", "unknown"];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "../../..");

// The signed helper's exit-code contract (see bridge/index.mjs HELPER_EXIT).
const HELPER_EXIT_EXPLANATIONS = {
  64: "the app-group socket was unavailable — Recall is not running or its MCP server is disabled",
  65: "the signed helper and the app share no MCP protocol version — update Recall",
  66: "Recall refused the connection (consent denied, revoked, or pending; signed out; or a different account) — review this agent's connection status and signed-in account in Recall",
  70: "the signed helper hit a protocol error talking to Recall",
};

function resolveDoctorOptions({
  host,
  clientName,
  sessionTools = "unknown",
  probe = false,
  readConnectionLog = false,
} = {}) {
  if (host !== undefined && !Object.hasOwn(CLIENT_NAMES, host)) {
    throw new TypeError(
      "Invalid host: expected claude-code, codex, or cursor.",
    );
  }
  const hostForClient = Object.keys(CLIENT_NAMES).find(
    (candidate) => CLIENT_NAMES[candidate] === clientName,
  );
  if (clientName !== undefined && !hostForClient) {
    throw new TypeError(
      "Invalid client name: expected Claude, Codex, or Cursor.",
    );
  }
  const selectedHost = host ?? hostForClient ?? "claude-code";
  if (hostForClient && hostForClient !== selectedHost) {
    throw new TypeError("The requested host and client name must match.");
  }
  if (!SESSION_TOOL_STATES.includes(sessionTools)) {
    throw new TypeError(
      "Invalid session tools: expected available, missing, or unknown.",
    );
  }
  if (typeof probe !== "boolean") {
    throw new TypeError("Invalid probe option: expected a boolean.");
  }
  if (typeof readConnectionLog !== "boolean") {
    throw new TypeError(
      "Invalid read-connection-log option: expected a boolean.",
    );
  }
  return {
    host: selectedHost,
    clientName: CLIENT_NAMES[selectedHost],
    sessionTools,
    probe,
    readConnectionLog,
  };
}

// How much of the newest connection log the consent-gated evidence read
// inspects (from the end — the incident's refusal is the newest event), and
// the only fields a captured RECALL_BRIDGE_STATUS line may surface. The
// allowlist mirrors docs/agent-collab/native-mcp-auth-diagnostics.md: adding
// a field here is an explicit decision, never a widening to raw stderr.
const CONNECTION_LOG_READ_BYTES = 256 * 1024;
const STATUS_MARKER = "RECALL_BRIDGE_STATUS:";

/**
 * Read the tail of the newest Claude Code connection log (consent-gated) and
 * extract the LAST helper status line and transport marker. Returns only
 * allowlisted fields — status, message, the typed diagnostic — never raw log
 * bodies, URLs, or credentials.
 */
export function readConnectionLogEvidence(newestFile, readFile = fs.readFileSync) {
  let content;
  try {
    const raw = readFile(newestFile);
    const bytes = raw.length > CONNECTION_LOG_READ_BYTES
      ? raw.subarray(raw.length - CONNECTION_LOG_READ_BYTES)
      : raw;
    content = bytes.toString("utf8");
  } catch {
    return { readable: false };
  }

  const evidence = { readable: true };
  for (const line of content.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const text = [entry.error, entry.debug]
      .filter((value) => typeof value === "string")
      .join("\n");
    if (!text) continue;
    const transport = text.match(/\[recall\] transport: (local-socket|oauth-http)/);
    if (transport) {
      evidence.lastTransport = transport[1];
      evidence.lastTransportAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    }
    const statusIndex = text.lastIndexOf(STATUS_MARKER);
    if (statusIndex >= 0) {
      const jsonText = text.slice(statusIndex + STATUS_MARKER.length).split("\n")[0];
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed.status === "string") {
          const captured = { status: parsed.status };
          if (typeof parsed.message === "string") captured.message = parsed.message;
          const diagnostic = parsed.diagnostic;
          if (diagnostic && typeof diagnostic === "object") {
            const typed = {};
            if (typeof diagnostic.reasonCode === "string") typed.reasonCode = diagnostic.reasonCode;
            if (typeof diagnostic.connectionId === "string") typed.connectionId = diagnostic.connectionId;
            if (Number.isInteger(diagnostic.errorCode)) typed.errorCode = diagnostic.errorCode;
            if (Object.keys(typed).length > 0) captured.diagnostic = typed;
          }
          evidence.lastRefusal = captured;
          evidence.lastRefusalAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
        }
      } catch {
        // A truncated or malformed status line stays unreported.
      }
    }
  }
  return evidence;
}

export function parseDoctorArguments(args) {
  const options = {};
  const keys = {
    "--host": "host",
    "--client-name": "clientName",
    "--session-tools": "sessionTools",
    "--probe": "probe",
    "--read-connection-log": "readConnectionLog",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const key = keys[flag];
    if (!Object.hasOwn(keys, flag)) {
      throw new TypeError(`Unknown doctor option: ${flag}`);
    }
    if (Object.hasOwn(options, key)) {
      throw new TypeError(`Duplicate doctor option: ${flag}`);
    }
    if (flag === "--probe" || flag === "--read-connection-log") {
      options[key] = true;
      continue;
    }
    const value = args[++index];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value.`);
    }
    options[key] = value;
  }
  return resolveDoctorOptions(options);
}

// Match the shipped MCP entrypoint for the selected client. This is still a
// separate process, never the host's existing conversation connection.
export function bridgeProbeArguments(options = {}) {
  const { host, clientName } = resolveDoctorOptions(options);
  const usesAdapter = host !== "cursor";
  return [
    path.join(pluginRoot, "bridge", "recall-node"),
    path.join(
      pluginRoot,
      "bridge",
      usesAdapter ? "session-adapter.mjs" : "index.mjs",
    ),
    ...(usesAdapter ? ["--host", host] : []),
    "--client-name",
    clientName,
  ];
}

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

function releaseProbeHandles(child) {
  // Only streams and the child handle created by this probe are released.
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try {
      stream?.destroy();
    } catch {
      /* Already closed. */
    }
  }
  try {
    child?.unref();
  } catch {
    /* Already reaped. */
  }
}

async function stopProbeProcessGroup(child, isClosed) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    releaseProbeHandles(child);
    return { status: "not_started" };
  }

  // detached:true below creates a POSIX group with this exact spawned PID.
  // Adapter, bridge, and helper/proxy inherit it. Never infer ownership from
  // names, argv, a machine-wide process walk, or the doctor's own group.
  const group = -pid;
  let signalError;
  const signalGroup = (signal) => {
    try {
      process.kill(group, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      signalError = error.code ?? "signal_failed";
      return true;
    }
  };
  const waitUntilStopped = async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    do {
      if (!signalGroup(0) && isClosed()) return true;
      await new Promise((resolve) =>
        setTimeout(resolve, PROBE_CLEANUP_POLL_MS),
      );
    } while (performance.now() < deadline);
    return !signalGroup(0) && isClosed();
  };

  let stopped = false;
  let forced = false;
  try {
    try {
      child.stdin?.end();
    } catch {
      /* Group termination still runs. */
    }
    signalGroup("SIGTERM");
    stopped = await waitUntilStopped(PROBE_TERMINATION_GRACE_MS);
    if (!stopped) {
      forced = true;
      signalGroup("SIGKILL");
      stopped = await waitUntilStopped(PROBE_FORCE_STOP_WAIT_MS);
    }
  } finally {
    // Even an OS-level termination failure must not hold the doctor open on
    // inherited pipes. It is reported as unverified cleanup, not success.
    releaseProbeHandles(child);
  }
  return {
    status: stopped ? "complete" : "unverified",
    forced,
    ...(signalError ? { signalError } : {}),
  };
}

// Launches a fresh bridge through the selected client's shipped entrypoint.
// A response proves only this initialize succeeded, not that existing tools
// are callable, workspace access is granted, or a lifecycle event was recorded.
export function probeBridgeInitialize({
  host,
  clientName,
  command = "/bin/sh",
  args = bridgeProbeArguments({ host, clientName }),
  timeoutMs = BRIDGE_PROBE_TIMEOUT_MS,
} = {}) {
  resolveDoctorOptions({ host, clientName });
  if (process.platform === "win32") {
    // Node's Windows detached children do not provide POSIX group ownership.
    // This Mac diagnostic must not start a tree it cannot safely terminate.
    return Promise.resolve({
      ok: false,
      reason: "probe_process_groups_unavailable",
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let childClosed = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cleanup;
      try {
        cleanup = await stopProbeProcessGroup(child, () => childClosed);
      } catch {
        releaseProbeHandles(child);
        cleanup = { status: "unverified" };
      }
      resolve(
        cleanup.status === "unverified"
          ? {
              ...result,
              ok: false,
              ...(result.reason ? { probeReason: result.reason } : {}),
              reason: "probe_cleanup_failed",
              cleanup,
            }
          : { ...result, cleanup },
      );
    };

    const failure = (reason, extra = {}) =>
      finish({
        ok: false,
        reason,
        ...(compactText(stderrBuffer)
          ? { stderrTail: compactText(stderrBuffer) }
          : {}),
        ...extra,
      });

    const timer = setTimeout(
      () => failure("timeout", { timeoutMs }),
      timeoutMs,
    );

    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      failure("spawn_failed", { error: compactText(error?.message) });
      return;
    }
    child.once("error", (error) =>
      failure("spawn_failed", { error: compactText(error?.message) }),
    );
    child.once("close", () => {
      childClosed = true;
    });
    child.stdin.once("error", (error) =>
      failure("write_failed", { error: compactText(error?.message) }),
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
      if (settled) return;
      stderrBuffer = (stderrBuffer + chunk).slice(-4_096);
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
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
            error: compactText(
              message.error.message ?? JSON.stringify(message.error),
            ),
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
  host,
  clientName,
  sessionTools = "unknown",
  appProcess,
  processTableAvailable = true,
  listener,
  sockets,
  sessionBridge,
  probe,
  logs,
  logEvidence,
}) {
  const selected = resolveDoctorOptions({ host, clientName, sessionTools });
  const currentSessionTools = {
    status: sessionTools,
    source: "caller_reported",
    scope: "current_conversation_read_tools",
  };
  const socketPresent = sockets.some((socket) => socket.present);
  const listenerReachable = listener.release || listener.debug;
  const probeSkipped = probe.skipped === true;
  const logsSupported =
    selected.host === "claude-code" && logs.supported !== false;

  const checks = [
    {
      name: "recall-app",
      ok: processTableAvailable ? Boolean(appProcess) : null,
      status: processTableAvailable
        ? appProcess
          ? "present"
          : "absent"
        : "unknown",
      severity: processTableAvailable ? "fail" : "warn",
      detail: !processTableAvailable
        ? "The process snapshot is unavailable; Recall's running state is unknown."
        : appProcess
          ? `Recall.app is running (pid ${appProcess.pid}).`
          : "No Recall.app process was found.",
      ...(appProcess || !processTableAvailable
        ? {}
        : { fix: "Open Recall for Mac — no Recall app process was observed." }),
    },
    {
      name: "mcp-listener",
      ok: listener.skipped ? null : Boolean(listenerReachable),
      status: listener.skipped
        ? "skipped"
        : listenerReachable
          ? "reachable"
          : "unreachable",
      severity: listener.skipped ? "info" : "fail",
      detail: listener.skipped
        ? "TCP reachability was not tested. Use --probe only after permission to open a new connection."
        : listenerReachable
          ? `Loopback MCP listener reachable on port ${[
              listener.release ? RELEASE_PORT : null,
              listener.debug ? DEBUG_PORT : null,
            ]
              .filter(Boolean)
              .join(" and ")}.`
          : `Neither 127.0.0.1:${RELEASE_PORT} (release) nor :${DEBUG_PORT} (debug) accepted the TCP probe.`,
      ...(listener.skipped || listenerReachable
        ? {}
        : {
            fix: "Recall's local MCP listener is unreachable: enable Settings -> MCP Server in Recall, then retry.",
          }),
    },
    {
      name: "app-group-socket",
      ok: socketPresent,
      // Socket presence does not establish support or authorize fallback;
      // the bridge retains its existing classified transport rules.
      severity: "warn",
      detail: sockets
        .map(
          (socket) =>
            `${socket.name}: ${socket.present ? "present" : "missing"}`,
        )
        .join(", "),
      ...(socketPresent
        ? {}
        : {
            fix: "No app-group MCP socket was found. Check Recall's MCP setting and app state. Socket absence does not authorize OAuth fallback; the bridge retains its existing transport rules.",
          }),
    },
    {
      name: "session-bridge",
      ok: sessionBridge.status === "present",
      status: sessionBridge.status,
      source: "process_snapshot",
      ...(sessionBridge.reason ? { reason: sessionBridge.reason } : {}),
      // A process snapshot is advisory. It does not override the current
      // caller's tool inventory or prove a successful authenticated call.
      severity: "warn",
      detail:
        sessionBridge.status === "present"
          ? `The process snapshot found a Recall bridge (pid ${sessionBridge.bridgePid}) under the recognized host (pid ${sessionBridge.hostPid}); tool availability and authentication are not verified by a process match.`
          : sessionBridge.status === "absent"
            ? `The process snapshot found no Recall bridge under the recognized host (pid ${sessionBridge.hostPid}); it does not establish why tools may be missing.`
            : sessionBridge.reason === "shared_host_process"
              ? "The shared host process cannot attribute a Recall bridge to an individual conversation."
              : `The process snapshot cannot determine this conversation's bridge (${sessionBridge.reason ?? "unknown"}).`,
      ...(sessionBridge.status === "present"
        ? {}
        : {
            fix: "Check the current conversation's Recall read tools and any actual read-call error; shared or unrecognized process ancestry is not evidence that the connector was skipped.",
          }),
    },
    {
      name: "current-session-tools",
      ok: sessionTools === "unknown" ? null : sessionTools === "available",
      status: sessionTools,
      source: "caller_reported",
      severity: sessionTools === "missing" ? "fail" : "warn",
      detail:
        sessionTools === "available"
          ? "The caller reports Recall read tools in the current conversation's tool inventory; a successful tool call is a separate observation."
          : sessionTools === "missing"
            ? "The caller reports no Recall read tools in the current conversation's tool inventory. The cause is not established by this report."
            : "The caller did not establish Recall read-tool availability in the current conversation.",
      ...(sessionTools === "available"
        ? {}
        : {
            fix: "Inspect the current conversation's Recall read tools or connector status. Missing write or lifecycle tools alone can reflect workspace policy or capabilities, not a missing connector.",
          }),
    },
    {
      name: "bridge-probe",
      ok: probeSkipped ? null : probe.ok,
      status: probeSkipped ? "skipped" : probe.ok ? "succeeded" : "failed",
      source: "fresh_connection",
      severity: probeSkipped ? "info" : "fail",
      detail: probeSkipped
        ? "No fresh bridge was launched. Use --probe only after permission; it can trigger Recall consent or OAuth."
        : probe.ok
          ? `A freshly launched bridge answered initialize: ${probe.serverInfo?.name ?? "unknown server"} ${probe.serverInfo?.version ?? ""}`.trim() +
            (probe.protocolVersion
              ? ` (protocol ${probe.protocolVersion}).`
              : ".") +
            " This does not verify the existing conversation's tools, workspace access, or journaling."
          : `The bridge did not answer initialize (${probe.reason}${
              probe.exitCode !== undefined ? `, exit ${probe.exitCode}` : ""
            }).${probe.exitCodeMeaning ? ` Likely cause: ${probe.exitCodeMeaning}.` : ""}${
              probe.stderrTail ? ` stderr: ${probe.stderrTail}` : ""
            }`,
      ...(probeSkipped || probe.ok
        ? {}
        : {
            fix:
              probe.exitCodeMeaning ??
              "The fresh initialize failed. Review the error and this agent's connection status in Recall; do not change approvals or configuration automatically.",
          }),
    },
    {
      name: "connection-logs",
      ok: logsSupported ? Boolean(logs.exists && logs.newestFile) : null,
      status: !logsSupported
        ? "unavailable"
        : logs.newestFile
          ? "present"
          : "missing",
      severity: "info",
      detail: !logsSupported
        ? `A connection-log layout for ${selected.clientName} has not been verified; no other client's logs were substituted.`
        : logs.exists
          ? logs.newestFile
            ? `Newest connection log: ${logs.newestFile} (modified ${logs.modifiedAt}, ${logs.fileCount} file${logs.fileCount === 1 ? "" : "s"}).`
            : `Log directory exists but is empty: ${logs.directory}`
          : `No Claude Code connection log directory was found at ${logs.directory}. This does not prove a connection was never attempted; logs can be absent, moved, or removed.`,
    },
    {
      name: "last-refusal",
      ok: logEvidence
        ? logEvidence.readable
          ? !logEvidence.lastRefusal
          : null
        : null,
      status: !logEvidence
        ? "skipped"
        : !logEvidence.readable
          ? "unreadable"
          : logEvidence.lastRefusal
            ? "refusal-recorded"
            : "none-found",
      source: "connection_log_body",
      severity: logEvidence?.lastRefusal ? "warn" : "info",
      detail: !logEvidence
        ? "The connection log body was not read. Pass --read-connection-log only with the user's consent to surface the last recorded refusal status."
        : !logEvidence.readable
          ? "The newest connection log could not be read."
          : logEvidence.lastRefusal
            ? `Last recorded refusal: status "${logEvidence.lastRefusal.status}"${
                logEvidence.lastRefusal.message ? ` — ${logEvidence.lastRefusal.message}` : ""
              }${logEvidence.lastRefusalAt ? ` (${logEvidence.lastRefusalAt})` : ""}${
                logEvidence.lastRefusal.diagnostic?.reasonCode
                  ? ` [reason ${logEvidence.lastRefusal.diagnostic.reasonCode}]`
                  : ""
              }. A recorded refusal is historical evidence, not the current state; a resilient bridge retries these automatically.`
            : `No RECALL_BRIDGE_STATUS refusal appears in the inspected tail${
                logEvidence.lastTransport ? ` (last transport: ${logEvidence.lastTransport})` : ""
              }.`,
    },
  ];

  const firstBroken =
    checks.find((check) => !check.ok && check.severity === "fail") ?? null;
  const warnings = checks.filter(
    (check) => !check.ok && check.severity === "warn",
  );
  const currentSummary =
    sessionTools === "available"
      ? "Recall read tools are reported available in the current conversation."
      : sessionTools === "missing"
        ? "Recall read tools are reported missing in the current conversation."
        : "Recall read-tool availability in the current conversation remains unverified.";
  const probeSummary = probeSkipped
    ? "Fresh connection probe skipped; no connection was started."
    : probe.ok
      ? `Fresh initialize succeeded${probe.serverInfo ? ` (${probe.serverInfo.name} ${probe.serverInfo.version})` : ""}; this does not verify a current tool call or journaling.`
      : "The fresh initialize failed; the existing conversation connection is separate.";

  return {
    host: selected.host,
    clientName: selected.clientName,
    currentSessionTools,
    pluginRoot,
    checks,
    firstBrokenLink: firstBroken?.name ?? null,
    summary: `${firstBroken ? `First failed check: ${firstBroken.name} — ${firstBroken.fix} ` : ""}${currentSummary} ${probeSummary}${warnings.length > 0 ? ` Warnings: ${warnings.map((check) => check.name).join(", ")}.` : ""}`,
  };
}

export async function runDoctor(
  options = {},
  {
    readTable = readProcessTable,
    startPid = process.pid,
    probeTcp = probeTcpPort,
    inspectSockets = inspectAppGroupSockets,
    probeBridge = probeBridgeInitialize,
    readLogs = newestMcpLog,
  } = {},
) {
  const selected = resolveDoctorOptions(options);
  // The process table is read before the probe launches its own short-lived
  // bridge, so the probe can never satisfy the session-bridge check.
  let rows = null;
  try {
    rows = readTable();
  } catch {
    // Process inspection is advisory and may be unavailable in a sandbox.
  }
  const sessionBridge = classifyBridgePresence(rows, startPid, {
    host: selected.host,
  });
  let listener = { release: null, debug: null, skipped: true };
  let probe = { ok: null, skipped: true, reason: "not_requested" };
  if (selected.probe) {
    const [release, debug] = await Promise.all([
      probeTcp(RELEASE_PORT),
      probeTcp(DEBUG_PORT),
    ]);
    listener = { release, debug };
    probe = await probeBridge({
      host: selected.host,
      clientName: selected.clientName,
    });
  }

  const logs = selected.host === "claude-code" ? readLogs() : { supported: false };
  // Reading the log BODY (as opposed to filenames/timestamps) is consent-gated
  // behind --read-connection-log, and even then surfaces only the allowlisted
  // helper status fields.
  const logEvidence =
    selected.readConnectionLog && selected.host === "claude-code" && logs.newestFile
      ? readConnectionLogEvidence(logs.newestFile)
      : undefined;

  return buildReport({
    host: selected.host,
    clientName: selected.clientName,
    sessionTools: selected.sessionTools,
    appProcess: findRecallAppProcess(rows),
    processTableAvailable: Array.isArray(rows) && rows.length > 0,
    listener,
    sockets: inspectSockets(),
    sessionBridge,
    probe,
    logs,
    logEvidence,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    const report = await runDoctor(parseDoctorArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error.message}\nUsage: recall-doctor --host claude-code|codex|cursor [--session-tools available|missing|unknown] [--probe] [--read-connection-log]\n`,
    );
    process.exitCode = 2;
  }
}
