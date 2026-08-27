// Detects whether the current agent session's host process actually started
// the Recall MCP bridge.
//
// A host can load this plugin's hooks and skills yet silently skip its MCP
// server for one session (observed 2026-08-27 in Claude Code desktop
// local-agent mode: every other plugin's server started, the Recall bridge
// was never launched, and no connection attempt was logged). The hooks still
// fire in such a session, so the hook process itself is the one place the
// omission is visible: the session's host process simply has no bridge child.
//
// The walk is deliberately scoped to the session's own host process rather
// than the whole machine. Concurrent sessions each run their own bridge, so a
// machine-wide scan would find a sibling session's healthy bridge and mask
// the broken session — exactly the incident this module exists to catch.
//
// Host support: the ancestor walk is generic, but the verdict requires the
// presumed host process to be recognized (Claude Code today). Other hosts can
// adopt detection by supplying their own host-command pattern once their
// process shapes are mapped; until then unrecognized hosts stay "unknown",
// which callers treat as "assume the bridge is fine".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PS_TIMEOUT_MS = 1_500;
const MAX_ANCESTOR_HOPS = 8;
const MAX_APP_ANCESTOR_HOPS = 3;
const MAX_DESCENDANTS_SCANNED = 4_096;

// The bridge appears in the process table either as recall-node exec'd onto
// bridge/index.mjs (any host's --client-name) or as the Recall-signed
// recall-mcp-bridge helper that index.mjs hands off to. The hook's own
// process runs hooks/journal-context.mjs and matches neither.
export const BRIDGE_COMMAND_PATTERN = /recall-mcp-bridge|bridge\/index\.mjs/;

// The Claude Code session process: the lowercase `claude` CLI binary (native
// install, Homebrew, or the desktop app's bundled
// .../claude.app/Contents/MacOS/claude) or a node invocation of the npm CLI.
// Deliberately case-sensitive so the desktop app binary (MacOS/Claude) and
// its helper processes are never mistaken for a session host.
export const CLAUDE_HOST_COMMAND_PATTERN =
  /(?:^|[\s/])claude(?:\s|$)|claude-code\/cli\.js/;

// Shell layers a host may leave between itself and the hook process (hook
// commands run through a shell, and recall-node execs node). These are
// skipped while walking up; the first non-shell ancestor is presumed to be
// the process that spawned the hook — the session's host. Shells match at
// any path (observed live: /opt/homebrew/bin/bash) and as login-shell argv0
// (-zsh); recall-node covers the case where a shell did not exec it away.
const WRAPPER_COMMAND_PATTERN =
  /(?:^|\/)-?(?:sh|bash|zsh|dash|fish)(?:\s|$)|recall-node/;

// The hook re-sanitizes the session id before trusting it as a filename
// component, even though callers already validate it.
const SESSION_TOKEN_PATTERN = /^[\w.:-]{1,128}$/;

export function parseProcessTable(text) {
  if (typeof text !== "string") return null;
  const rows = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    });
  }
  return rows.length > 0 ? rows : null;
}

export function readProcessTable(spawn = spawnSync) {
  const result = spawn("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return parseProcessTable(result.stdout);
}

export function classifyBridgePresence(
  rows,
  startPid,
  {
    bridgeCommandPattern = BRIDGE_COMMAND_PATTERN,
    hostCommandPattern = CLAUDE_HOST_COMMAND_PATTERN,
  } = {},
) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: "unknown", reason: "no_process_table" };
  }

  const rowsByPid = new Map();
  const childrenByPpid = new Map();
  for (const row of rows) {
    rowsByPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }

  let current = rowsByPid.get(startPid);
  if (!current) return { status: "unknown", reason: "start_process_not_listed" };

  let host = null;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = rowsByPid.get(current.ppid);
    if (!parent || parent.pid === current.pid || parent.pid <= 1) break;
    if (!WRAPPER_COMMAND_PATTERN.test(parent.command)) {
      host = parent;
      break;
    }
    current = parent;
  }
  if (!host) return { status: "unknown", reason: "no_host_ancestor" };
  if (!hostCommandPattern.test(host.command)) {
    return {
      status: "unknown",
      reason: "host_not_recognized",
      hostPid: host.pid,
      hostCommand: host.command,
    };
  }

  // BFS over a subtree for a bridge-looking command. The start process's own
  // subtree is skipped (it holds only this detection's helpers, like the ps
  // call itself), and pruned subtrees — other sessions' host processes — are
  // not descended into.
  const findBridgeDescendant = (rootPid, prunePattern = null) => {
    const queue = [rootPid];
    let scanned = 0;
    while (queue.length > 0 && scanned < MAX_DESCENDANTS_SCANNED) {
      const children = childrenByPpid.get(queue.shift()) ?? [];
      for (const child of children) {
        scanned += 1;
        if (child.pid === startPid) continue;
        if (bridgeCommandPattern.test(child.command)) return child;
        if (prunePattern?.test(child.command)) continue;
        queue.push(child.pid);
      }
    }
    return null;
  };

  const bridge = findBridgeDescendant(host.pid);
  if (bridge) {
    return {
      status: "present",
      hostPid: host.pid,
      hostCommand: host.command,
      bridgePid: bridge.pid,
      bridgeCommand: bridge.command,
    };
  }

  // A desktop host can also attach a session's server to an app-level
  // ancestor instead of the session process (observed live: a disclaimer-
  // wrapped bridge as a direct child of Claude.app while sessions' own
  // bridges were children of their claude CLI processes). An app-level
  // bridge cannot be attributed to one session from the tree alone, so its
  // presence softens "absent" to "unknown". Sibling sessions' bridges never
  // mute detection: any ancestor subtree rooted at a process matching the
  // host pattern — another session, or a wrapper around one — is pruned.
  let ancestor = host;
  for (let hop = 0; hop < MAX_APP_ANCESTOR_HOPS; hop += 1) {
    const parent = rowsByPid.get(ancestor.ppid);
    if (!parent || parent.pid === ancestor.pid || parent.pid <= 1) break;
    const appLevelBridge = findBridgeDescendant(parent.pid, hostCommandPattern);
    if (appLevelBridge) {
      return {
        status: "unknown",
        reason: "unattributed_app_level_bridge",
        hostPid: host.pid,
        hostCommand: host.command,
        bridgePid: appLevelBridge.pid,
        bridgeCommand: appLevelBridge.command,
      };
    }
    ancestor = parent;
  }

  return { status: "absent", hostPid: host.pid, hostCommand: host.command };
}

export function bridgeStatusCachePath(
  sessionId,
  temporaryDirectory = os.tmpdir(),
) {
  if (typeof sessionId !== "string" || !SESSION_TOKEN_PATTERN.test(sessionId)) {
    return null;
  }
  return path.join(temporaryDirectory, `recall-bridge-status-${sessionId}.json`);
}

// Only a positive verdict is cached: a bridge observed once stays valid for
// the session, so healthy sessions pay for one process walk total. Absence is
// re-walked on every call because a host could in principle start the server
// after the first prompt, and a pinned false "absent" would nag forever; the
// broken session that keeps re-walking is the rare case, and one ps scan per
// prompt is well inside the hook budget. "unknown" is never cached.
export function detectBridgeStatus({
  sessionId = null,
  startPid = process.pid,
  readTable = readProcessTable,
  temporaryDirectory = os.tmpdir(),
  bridgeCommandPattern,
  hostCommandPattern,
} = {}) {
  const cachePath = bridgeStatusCachePath(sessionId, temporaryDirectory);
  if (cachePath) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (cached?.status === "present") return cached;
    } catch {
      // No usable cache; fall through to a fresh walk.
    }
  }

  let verdict;
  try {
    verdict = classifyBridgePresence(readTable(), startPid, {
      ...(bridgeCommandPattern ? { bridgeCommandPattern } : {}),
      ...(hostCommandPattern ? { hostCommandPattern } : {}),
    });
  } catch {
    verdict = { status: "unknown", reason: "process_walk_failed" };
  }

  if (cachePath && verdict.status === "present") {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(verdict));
    } catch {
      // Caching is an optimization; detection still succeeded.
    }
  }
  return verdict;
}
