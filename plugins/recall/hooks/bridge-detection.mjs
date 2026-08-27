// A fresh process snapshot can suggest that a per-session CLI omitted Recall.
// It cannot prove tool availability, host identity, authorization, or recording.
// Shared desktop/app-server trees cannot identify one conversation's connector.
// Never persist argv: process commands can contain private prompts and paths.

import { spawnSync } from "node:child_process";

const PS_TIMEOUT_MS = 1_500;
const MAX_PROCESS_ROWS = 16_384;
const MAX_COMMAND_LENGTH = 16_384;
const MAX_PROCESS_TABLE_BYTES = 8 * 1024 * 1024;
const MAX_ANCESTOR_HOPS = 8;
const MAX_APP_ANCESTOR_HOPS = 3;
const MAX_DESCENDANTS_SCANNED = 4_096;
const HOSTS = new Set(["claude-code", "codex", "cursor"]);

function verdict(status, details = {}) {
  return { status, source: "process_snapshot", ...details };
}

function validRow(row) {
  return (
    Number.isSafeInteger(row?.pid) &&
    row.pid > 0 &&
    Number.isSafeInteger(row?.ppid) &&
    row.ppid >= 0 &&
    typeof row?.command === "string" &&
    row.command.length > 0 &&
    row.command.length <= MAX_COMMAND_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(row.command)
  );
}

export function parseProcessTable(text) {
  if (typeof text !== "string" || text.length > MAX_PROCESS_TABLE_BYTES)
    return null;
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    // A partial table cannot establish absence.
    if (!match || rows.length >= MAX_PROCESS_ROWS) return null;
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    };
    if (!validRow(row)) return null;
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

export function readProcessTable(spawn = spawnSync) {
  const result = spawn("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_TABLE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    return null;
  return parseProcessTable(result.stdout);
}

// ps does not escape argv consistently. Recognize an executable/script only
// at its command position, never a host name occurring inside a prompt or a
// shell command. Unrecognized paths (including ambiguous spaces) stay unknown.
function firstArgument(command) {
  const match = command.match(/^(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))(?:\s+|$)/);
  return match
    ? {
        value: match[1] ?? match[2] ?? match[3],
        rest: command.slice(match[0].length),
      }
    : null;
}

function executable(command) {
  // Claude desktop's per-session CLI has this known, unquoted space in ps.
  const bundledClaude = command.match(
    /^\/(?:[^\s/]+\/)*Library\/Application Support\/Claude\/claude-code\/[^\s/]+\/claude\.app\/Contents\/MacOS\/claude(?:\s+|$)/,
  );
  if (bundledClaude)
    return { value: "claude", rest: command.slice(bundledClaude[0].length) };
  return firstArgument(command);
}

function basename(value) {
  return value.slice(value.lastIndexOf("/") + 1);
}

function hostProcess(command) {
  const process = executable(command);
  if (!process) return null;
  const name = basename(process.value);
  if (name === "claude") return { host: "claude-code", scope: "session" };
  if (name === "codex")
    return {
      host: "codex",
      // TUI and app-server can retain multiple conversations/subagents.
      // A mode name alone cannot establish isolated connector ownership.
      scope: /(?:^|\s)(?:exec|e)(?:\s|$)/.test(process.rest)
        ? "unverified"
        : "shared",
    };
  if (name === "node") {
    const script = firstArgument(process.rest)?.value;
    if (
      script &&
      (basename(script) === "claude" ||
        /(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(script))
    )
      return { host: "claude-code", scope: "session" };
  }
  // The official installer uses this branded path. Its current per-session
  // ownership has not been exercised, so recognition supplies guidance only.
  // A generic `agent` is not Cursor evidence (other products use that name).
  if (
    /\/(?:\.local\/share\/)?cursor-agent\/versions\/[^/]+\/cursor-agent$/.test(
      process.value,
    )
  )
    return { host: "cursor", scope: "unverified" };
  if (name === "Claude") return { host: "claude-code", scope: "shared" };
  if (name === "Codex") return { host: "codex", scope: "shared" };
  if (name === "Cursor" || /\/Cursor\.app\/Contents\//.test(process.value))
    return { host: "cursor", scope: "shared" };
  return null;
}

function isShellWrapper(command) {
  const process = executable(command);
  return (
    process && /^-?(?:sh|bash|zsh|dash|fish)$/.test(basename(process.value))
  );
}

function recallScript(command) {
  const process = executable(command);
  if (!process || basename(process.value) !== "node") return null;
  const script = firstArgument(process.rest)?.value;
  // Match Recall's source/cache layouts, not another plugin's bridge/index.
  return typeof script === "string"
    ? (script.match(
        /(?:^|\/)recall\/(?:[^/]+\/){0,2}bridge\/(index|session-adapter)\.mjs$/,
      )?.[1] ?? null)
    : null;
}

function isBridge(command) {
  const process = executable(command);
  return (
    process &&
    (basename(process.value) === "recall-mcp-bridge" ||
      recallScript(command) === "index")
  );
}

function isBridgeWrapper(command) {
  if (isShellWrapper(command) || recallScript(command) === "session-adapter")
    return true;
  // A known desktop launch wrapper does not own a separate agent session.
  const process = executable(command);
  return (
    process &&
    /\/Claude\.app\/Contents\/Helpers\/disclaimer$/.test(process.value)
  );
}

export function classifyBridgePresence(
  rows,
  startPid,
  { host = "claude-code" } = {},
) {
  if (!HOSTS.has(host))
    return verdict("unknown", { reason: "unsupported_host" });
  if (!Array.isArray(rows) || rows.length === 0)
    return verdict("unknown", { reason: "no_process_table" });
  if (rows.length > MAX_PROCESS_ROWS)
    return verdict("unknown", { reason: "process_scan_limit" });

  const rowsByPid = new Map();
  const childrenByPpid = new Map();
  for (const row of rows) {
    if (!validRow(row) || rowsByPid.has(row.pid))
      return verdict("unknown", { reason: "invalid_process_table" });
    rowsByPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }

  let current = rowsByPid.get(startPid);
  if (!current)
    return verdict("unknown", { reason: "start_process_not_listed" });
  const ownAncestors = new Set([startPid]);
  let session = null;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = rowsByPid.get(current.ppid);
    if (!parent || parent.pid <= 1) break;
    if (ownAncestors.has(parent.pid))
      return verdict("unknown", { reason: "invalid_process_table" });
    if (!isShellWrapper(parent.command)) {
      session = parent;
      break;
    }
    ownAncestors.add(parent.pid);
    current = parent;
  }
  if (!session) return verdict("unknown", { reason: "no_host_ancestor" });
  const identity = hostProcess(session.command);
  if (identity?.host !== host)
    return verdict("unknown", {
      reason: "host_not_recognized",
      hostPid: session.pid,
    });
  if (identity.scope !== "session")
    return verdict("unknown", {
      reason:
        identity.scope === "shared"
          ? "shared_host_process"
          : "unverified_cli_boundary",
      hostPid: session.pid,
    });

  // Prune every known host boundary, including nested and other-agent runs.
  // Finding one of their bridges says nothing about the requested session.
  const findBridgeDescendant = (rootPid) => {
    const queue = [{ pid: rootPid, attributed: true }];
    const visited = new Set([rootPid]);
    let scanned = 0;
    let unattributedBridge;
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      for (const child of childrenByPpid.get(current.pid) ?? []) {
        if (++scanned > MAX_DESCENDANTS_SCANNED)
          return { reason: "process_scan_limit" };
        if (visited.has(child.pid)) return { reason: "invalid_process_table" };
        visited.add(child.pid);
        if (ownAncestors.has(child.pid) || hostProcess(child.command)) continue;
        if (isBridge(child.command)) {
          if (current.attributed) return { bridge: child };
          unattributedBridge ??= child;
          continue;
        }
        // An unknown owner may be another agent, even when its executable is
        // merely called `agent` or `node`. Its bridge cannot prove this run's
        // connector. Keep looking for an independently attributable bridge.
        queue.push({
          pid: child.pid,
          attributed: current.attributed && isBridgeWrapper(child.command),
        });
      }
    }
    return { unattributedBridge };
  };

  const found = findBridgeDescendant(session.pid);
  if (found.reason)
    return verdict("unknown", { reason: found.reason, hostPid: session.pid });
  if (found.bridge)
    return verdict("present", {
      hostPid: session.pid,
      bridgePid: found.bridge.pid,
    });
  if (found.unattributedBridge)
    return verdict("unknown", {
      reason: "unattributed_descendant_bridge",
      hostPid: session.pid,
      bridgePid: found.unattributedBridge.pid,
    });

  // Some desktop clients attach a bridge above the session CLI. Such a bridge
  // is unattributable, not proof of current-session presence or absence.
  let ancestor = session;
  const visitedAncestors = new Set([session.pid]);
  for (let hop = 0; hop < MAX_APP_ANCESTOR_HOPS; hop += 1) {
    const parent = rowsByPid.get(ancestor.ppid);
    if (!parent || parent.pid <= 1) break;
    if (visitedAncestors.has(parent.pid))
      return verdict("unknown", {
        reason: "invalid_process_table",
        hostPid: session.pid,
      });
    visitedAncestors.add(parent.pid);
    const appLevel = findBridgeDescendant(parent.pid);
    if (appLevel.reason)
      return verdict("unknown", {
        reason: appLevel.reason,
        hostPid: session.pid,
      });
    const bridge = appLevel.bridge ?? appLevel.unattributedBridge;
    if (bridge)
      return verdict("unknown", {
        reason: "unattributed_app_level_bridge",
        hostPid: session.pid,
        bridgePid: bridge.pid,
      });
    ancestor = parent;
  }
  return verdict("absent", { hostPid: session.pid });
}

// No positive cache: a bridge can exit or restart during the same thread.
// Each result is fresh, bounded, advisory evidence; no argv or session IDs
// are written to disk, and old recall-bridge-status files are never read.
export function detectBridgeStatus({
  host = "claude-code",
  startPid = process.pid,
  readTable = readProcessTable,
} = {}) {
  try {
    return classifyBridgePresence(readTable(), startPid, { host });
  } catch {
    return verdict("unknown", { reason: "process_walk_failed" });
  }
}
