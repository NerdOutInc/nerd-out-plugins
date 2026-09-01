#!/usr/bin/env node
// Stdio bridge to Recall's local MCP server (v3) — a resilient, MCP-aware
// supervisor.
//
// Preferred path — the app-issued local socket: Recall.app ships a
// Recall-SIGNED helper (recall-mcp-bridge) in Contents/Helpers. When it's on
// disk, this supervisor execs it and pumps MCP stdio through it; the helper
// connects to a Unix socket in Recall's app-group container, the app verifies
// the helper's code signature and the signed-in user's one-time consent, and
// serves MCP over the socket. No browser, no DCR, no tokens on disk — nothing
// for this bridge to refresh or lose. See
// recall-app docs/mcp-app-issued-credentials-plan.md.
//
// Resilience contract (the 2026-09-01 incident): a refused hello (signed_out,
// starting, approval_pending, denied, …), a socket that is not there yet, or a
// connection dropped mid-conversation must NOT kill this process — an MCP
// host marks a dead server failed for the rest of the conversation, with no
// retry and no user-visible reason. Instead the supervisor stays on stdio as
// a degraded MCP server (initialize succeeds, tool calls return the bounded
// human-readable status Recall sent) and keeps re-dialing the helper with
// backoff. When the app becomes ready — the user signs in, unlocks, finishes
// launching, or re-enables the MCP server — the bridge replays the session
// handshake over the fresh socket, notifies the host that the tool list
// changed, and tools recover in the SAME conversation. Grants persist per
// user + attested host, so recovery never re-prompts.
//
// Fallback path — legacy OAuth: when the helper is ABSENT (an older Recall
// that predates the socket) or reports an UNSUPPORTED protocol version, this
// wrapper falls back to a bundled copy of mcp-remote (MIT, see
// LICENSE-mcp-remote.txt), which proxies stdio to the loopback HTTP listener
// and runs the MCP OAuth flow (browser sign-in, token cache in ~/.mcp-auth,
// refresh) against the Recall authorization server. Every OTHER helper
// outcome — denied/revoked/pending consent, signed out, wrong account, a bad
// signature, a protocol error — is surfaced to the MCP client as a degraded
// status and NEVER silently downgraded to OAuth: a spoofed downgrade would
// defeat the consent the user just made.
//
// This bridge and client-identity.mjs are duplicated under
// desktop-extensions/recall/server; keep both pairs byte-identical.
// The desktop extension ships as a self-contained package, so it cannot
// import modules shared with the plugin.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  clientCacheDirectory,
  oauthScopeForSupportedScopes,
  parseClientName,
  proxyArgs,
} from "./client-identity.mjs";

const SERVER_URL = "http://127.0.0.1:38473/mcp";
const HOST = "127.0.0.1";
const PORT = 38473;
const WAIT_FOR_APP_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const OAUTH_METADATA_TIMEOUT_MS = 2_000;

// The helper's exit-code contract (recall-app apple-app/McpBridgeSources).
const HELPER_EXIT = {
  cleanEOF: 0,
  socketUnavailable: 64, // app not running / MCP disabled — keep re-dialing
  unsupportedVersion: 65, // no protocol overlap — OAuth fallback permitted
  refused: 66, // denied/revoked/pending/signed-out/starting/mismatch/unauth —
  // surface the status, stay alive, keep re-dialing
  protocolError: 70, // malformed handshake — surface, retry, never OAuth
};

// How long a request may wait for a live connection before it is answered
// locally (initialize/tools/list) or errored with the last refusal status
// (tools/call). Sits under every host's own startup timeout (~30 s observed)
// so the host sees a working server even while Recall is still refusing.
const HOLD_MS = readPositiveInt(process.env.RECALL_BRIDGE_HOLD_MS, 20_000);
// Re-dial backoff bounds. Reconnecting is cheap (one helper spawn + one
// refused hello) and prompts nothing: consent tombstones refuse silently and
// the app's own consent path rate-limits prompt storms.
const RETRY_MIN_MS = readPositiveInt(
  process.env.RECALL_BRIDGE_RETRY_MIN_MS,
  1_000
);
const RETRY_MAX_MS = readPositiveInt(
  process.env.RECALL_BRIDGE_RETRY_MAX_MS,
  15_000
);
// Per-line cap for traffic crossing this proxy, matching the generous
// no-cap behavior the inherited-stdio pump had in practice.
const MAX_LINE_BYTES = 32 * 1024 * 1024;

// Candidate locations for the Recall-signed helper inside an installed
// Recall.app. The plugin can't know the exact bundle path, so it checks the
// standard install locations for both the release and dev bundles; a
// RECALL_MCP_BRIDGE override wins for testing.
const HELPER_RELATIVE_PATH = "Contents/Helpers/recall-mcp-bridge";

// Prefix for the one-line "which transport did this session use" marker. Both
// paths speak identical MCP stdio to the host, so without this the choice is
// invisible in a host's MCP log.
const TRANSPORT_MARKER = "transport:";

// Prefix of the helper's machine-readable status line on stderr.
const STATUS_MARKER = "RECALL_BRIDGE_STATUS:";

function log(message) {
  process.stderr.write(`[recall] ${message}\n`);
}

function readPositiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let clientName;
try {
  clientName = parseClientName(process.argv.slice(2));
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

function isExecutable(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Locate the app-issued helper, or null when no socket-capable Recall is
// installed (→ legacy OAuth fallback).
function locateHelper() {
  const override = process.env.RECALL_MCP_BRIDGE;
  if (override) {
    return isExecutable(override) ? override : null;
  }
  const appDirectories = [
    "/Applications",
    path.join(os.homedir(), "Applications"),
  ];
  const bundleNames = ["Recall.app", "Recall (Dev).app"];
  for (const directory of appDirectories) {
    for (const bundleName of bundleNames) {
      const candidate = path.join(directory, bundleName, HELPER_RELATIVE_PATH);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Incremental newline splitter with a hard per-line cap. */
class LineSplitter {
  constructor(onLine, onOverflow) {
    this.buffer = Buffer.alloc(0);
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }

  push(chunk) {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.onOverflow?.();
    }
  }
}

function parseJson(line) {
  try {
    const value = JSON.parse(line.toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The resilient local-socket transport: an MCP-aware proxy between the host's
 * stdio and successive helper processes. One instance lives for the whole
 * conversation; helper connections come and go underneath it.
 */
class ResilientLocalBridge {
  constructor(helperPath) {
    this.helperPath = helperPath;
    // The host's initialize request — raw bytes for first-connect forwarding,
    // parsed params for handshake replay on every reconnect.
    this.clientInitialize = null;
    this.clientSentInitialized = false;
    this.initializeAnswered = false;
    // Requests waiting for a live connection: {raw, parsed, timer}.
    this.pending = [];
    // Ids of requests forwarded to the live connection and not yet answered.
    this.inflight = new Set();
    this.connection = null;
    this.everReady = false;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.lastStatus = {
      status: "connecting",
      message: "The Recall bridge is still connecting to the Recall app.",
    };
    this.lastLoggedStatus = null;
    this.announcedSocketWait = false;
    this.clientClosed = false;
    this.shuttingDown = false;
    this.replayCounter = 0;
    this.stdinPaused = false;
  }

  start() {
    const splitter = new LineSplitter(
      (line) => this.handleClientLine(line),
      () => this.fatal("stdin line exceeded the bridge's size cap")
    );
    process.stdin.on("data", (chunk) => splitter.push(chunk));
    process.stdin.on("end", () => this.handleClientEnd());
    process.stdin.on("error", () => this.handleClientEnd());
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        this.shuttingDown = true;
        this.connection?.child.kill(signal);
        process.exit(0);
      });
    }
  }

  // MARK: host → bridge

  handleClientLine(raw) {
    const parsed = parseJson(raw);
    if (!parsed) {
      // Not a JSON-RPC line; forward verbatim when connected, drop otherwise.
      if (this.isReady()) {
        this.writeToHelper(raw);
      }
      return;
    }

    if (parsed.method === "initialize" && parsed.id !== undefined) {
      this.clientInitialize = { raw: Buffer.from(raw), parsed };
      this.ensureDialing({ immediate: true });
      if (this.isReady()) {
        // A second initialize on a live connection is the host's business;
        // pass it through untouched.
        this.forwardClientRequest(raw, parsed);
        return;
      }
      this.hold(raw, parsed);
      return;
    }

    if (parsed.method === "notifications/initialized") {
      this.clientSentInitialized = true;
      if (this.isReady()) {
        this.writeToHelper(raw);
      }
      // While disconnected the reconnect handshake replays this notification
      // itself, so the held copy would only duplicate it.
      return;
    }

    if (parsed.method === "notifications/cancelled") {
      const cancelledId = parsed.params?.requestId;
      const index = this.pending.findIndex(
        (entry) => entry.parsed.id === cancelledId
      );
      if (index >= 0) {
        clearTimeout(this.pending[index].timer);
        this.pending.splice(index, 1);
        return;
      }
      if (this.isReady()) {
        this.writeToHelper(raw);
      }
      return;
    }

    if (this.isReady()) {
      this.forwardClientRequest(raw, parsed);
      return;
    }

    if (parsed.id === undefined || parsed.method === undefined) {
      // A notification (or a response to a server-initiated request) with no
      // live connection has nowhere to go.
      return;
    }

    if (parsed.method === "ping") {
      this.writeToClient({ jsonrpc: "2.0", id: parsed.id, result: {} });
      return;
    }

    this.ensureDialing();
    if (this.connection) {
      // An attempt is in flight (it may be parked on a consent prompt for up
      // to two minutes): hold the request so it rides the connection the
      // moment the handshake lands.
      this.hold(raw, parsed);
      return;
    }
    // Between retries with a known refusal: answer immediately rather than
    // sitting on the request — the error carries the human-readable status
    // and says the bridge is still retrying.
    this.answerLocally(parsed);
  }

  forwardClientRequest(raw, parsed) {
    if (parsed.id !== undefined && parsed.method !== undefined) {
      this.inflight.add(parsed.id);
    }
    this.writeToHelper(raw);
  }

  hold(raw, parsed) {
    const entry = {
      raw: Buffer.from(raw),
      parsed,
      timer: setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this.answerLocally(entry.parsed);
        }
      }, HOLD_MS),
    };
    this.pending.push(entry);
  }

  flushPending() {
    const held = this.pending;
    this.pending = [];
    for (const entry of held) {
      clearTimeout(entry.timer);
      if (
        entry.parsed.method === "initialize" &&
        this.initializeAnswered
      ) {
        // Already answered (locally, or by a previous connection's probe).
        continue;
      }
      this.forwardClientRequest(entry.raw, entry.parsed);
    }
  }

  // A held request outlived every reconnect attempt inside its window:
  // answer it from the bridge so the host is never left hanging.
  answerLocally(parsed) {
    const { id, method } = parsed;
    if (method === "initialize") {
      this.initializeAnswered = true;
      this.writeToClient({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: parsed.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "recall", version: "0.0.0-degraded" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      this.writeToClient({ jsonrpc: "2.0", id, result: { tools: [] } });
      return;
    }
    this.writeToClient({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: this.degradedMessage(),
      },
    });
  }

  degradedMessage() {
    const { status, message } = this.lastStatus;
    return (
      `Recall is not available right now (${status}): ${message} ` +
      "The Recall bridge stays connected and retries automatically — " +
      "try this call again once Recall is ready."
    );
  }

  // MARK: dialing

  ensureDialing({ immediate = false } = {}) {
    if (this.connection || this.clientClosed || !this.clientInitialize) {
      return;
    }
    if (this.retryTimer) {
      if (!immediate) {
        return;
      }
      // A fresh initialize deserves a fresh attempt now, not at the backoff
      // deadline.
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.startAttempt();
  }

  scheduleRetry() {
    if (this.retryTimer || this.clientClosed) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startAttempt();
    }, this.retryDelay);
    // Timers must not keep the process alive after the host disconnects.
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  startAttempt() {
    const child = spawn(this.helperPath, ["--client-name", clientName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const isFirstConnect =
      !this.everReady && !this.initializeAnswered && this.clientInitialize;
    let probe;
    let probeId;
    let forwardProbeResponse;
    if (isFirstConnect) {
      probe = this.clientInitialize.raw;
      probeId = this.clientInitialize.parsed.id;
      forwardProbeResponse = true;
    } else {
      this.replayCounter += 1;
      probeId = `__recall_bridge_replay_${this.replayCounter}`;
      probe = Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: probeId,
          method: "initialize",
          params: this.clientInitialize.parsed.params ?? {},
        })}\n`
      );
      forwardProbeResponse = false;
    }

    const connection = {
      child,
      phase: "handshake",
      probeId,
      forwardProbeResponse,
      status: null,
    };
    this.connection = connection;

    const stdoutSplitter = new LineSplitter(
      (line) => this.handleHelperLine(connection, line),
      () => this.dropConnection(connection, "helper output exceeded size cap")
    );
    child.stdout.on("data", (chunk) => stdoutSplitter.push(chunk));

    // Tee helper stderr through, capturing the machine-readable status line
    // so refusals can be surfaced on tool calls (stdio is piped, so the raw
    // stream would otherwise vanish with the helper).
    const stderrSplitter = new LineSplitter((line) => {
      const text = line.toString("utf8");
      if (text.startsWith(STATUS_MARKER)) {
        const status = parseJson(
          Buffer.from(text.slice(STATUS_MARKER.length))
        );
        if (status && typeof status.status === "string") {
          connection.status = {
            status: status.status,
            message:
              typeof status.message === "string" && status.message
                ? status.message
                : "Recall refused the local MCP connection.",
          };
        }
      }
      process.stderr.write(`${text}\n`);
    });
    child.stderr.on("data", (chunk) => stderrSplitter.push(chunk));

    child.stdin.on("error", () => {});
    child.on("error", () => {
      this.handleHelperExit(connection, HELPER_EXIT.socketUnavailable);
    });
    child.on("exit", (code, signal) => {
      this.handleHelperExit(connection, signal ? 1 : (code ?? 1));
    });

    // The helper never reads stdin before an approved handshake, so a refused
    // attempt loses nothing: this is our replayable copy, and the kernel pipe
    // simply drops with the process.
    this.writeToHelper(probe);
  }

  handleHelperLine(connection, raw) {
    if (this.connection !== connection) {
      return;
    }
    if (connection.phase === "handshake") {
      const parsed = parseJson(raw);
      if (parsed && parsed.id === connection.probeId) {
        this.becomeReady(connection, raw, parsed);
        return;
      }
      // A server-initiated notification racing the handshake: pass it on.
      this.writeToClientRaw(raw);
      return;
    }
    const parsed = parseJson(raw);
    if (parsed && parsed.id !== undefined && parsed.method === undefined) {
      this.inflight.delete(parsed.id);
    }
    this.writeToClientRaw(raw);
  }

  becomeReady(connection, probeResponseRaw) {
    connection.phase = "ready";
    const reconnected = this.everReady || this.initializeAnswered;
    this.everReady = true;
    this.retryDelay = RETRY_MIN_MS;
    this.lastStatus = {
      status: "connected",
      message: "Connected to the Recall app.",
    };
    this.lastLoggedStatus = null;

    if (connection.forwardProbeResponse && !this.initializeAnswered) {
      this.initializeAnswered = true;
      this.writeToClientRaw(probeResponseRaw);
    } else {
      // The probe's response belongs to the bridge, not the host — either
      // this is a reconnect's replayed handshake, or the host's initialize
      // was already answered locally while the app took its time (e.g. a
      // consent prompt). Finish the app-side handshake so the fresh session
      // is fully initialized before real traffic flows.
      this.initializeAnswered = true;
      this.writeToHelper(
        Buffer.from(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          })}\n`
        )
      );
    }

    this.flushPending();

    if (reconnected && this.clientSentInitialized) {
      // The host may hold an empty or stale tool list from the degraded
      // window; a list_changed notification makes it re-fetch.
      this.writeToClient({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
    }
    if (reconnected) {
      log("reconnected to Recall; tools restored.");
    }
  }

  handleHelperExit(connection, code) {
    if (this.connection !== connection || this.shuttingDown) {
      return;
    }
    this.connection = null;

    if (this.clientClosed) {
      process.exit(0);
    }

    if (connection.phase === "ready") {
      // A live session dropped: sign-out, MCP toggle, app quit, or a crash.
      // Fail what was in flight, then re-dial (fresh backoff — the connection
      // was healthy moments ago).
      this.failInflight();
      this.retryDelay = RETRY_MIN_MS;
      this.noteDegraded(
        connection.status ?? {
          status: "disconnected",
          message:
            code === HELPER_EXIT.cleanEOF
              ? "Recall closed the local MCP connection."
              : "The local MCP connection to Recall was lost.",
        }
      );
      this.scheduleRetry();
      return;
    }

    // Handshake attempt failed.
    if (
      code === HELPER_EXIT.unsupportedVersion &&
      !this.everReady
    ) {
      // The installed Recall is older than this bridge's protocol; the legacy
      // OAuth path still reaches the same app. The ONLY ack-driven fallback.
      log(
        "Recall's local bridge protocol is older than this plugin; using OAuth."
      );
      this.handOffToOAuth();
      return;
    }

    if (code === HELPER_EXIT.socketUnavailable) {
      if (!this.announcedSocketWait) {
        log(
          "Waiting for the Recall Mac app — it isn't running, or its MCP " +
            "server is disabled in Settings. A locked screen does not cause " +
            "this. Launch Recall; this bridge will connect automatically."
        );
        this.announcedSocketWait = true;
      }
      this.noteDegraded(
        connection.status ?? {
          status: "no_socket",
          message:
            "The Recall app is not running, or its MCP server is disabled.",
        },
        { quiet: true }
      );
      this.drainPendingOnFailure();
      this.scheduleRetry();
      return;
    }

    // Refusals (denied / revoked / pending / signed_out / starting /
    // user_mismatch / unauthenticated), protocol errors, a clean close during
    // the handshake, and an unsupported-version answer after a previously
    // working socket all keep the bridge alive: surface the status, keep
    // re-dialing, and NEVER fall back to OAuth — a silent downgrade would
    // defeat the consent the user just made in Recall.
    let fallbackStatus = "refused";
    let fallbackMessage = "Recall refused the local MCP connection.";
    if (code === HELPER_EXIT.cleanEOF) {
      fallbackStatus = "disconnected";
      fallbackMessage = "Recall closed the local MCP connection during the handshake.";
    } else if (code === HELPER_EXIT.protocolError) {
      fallbackStatus = "protocol_error";
    }
    this.noteDegraded(
      connection.status ?? { status: fallbackStatus, message: fallbackMessage }
    );
    this.drainPendingOnFailure();
    this.scheduleRetry();
  }

  // A connection attempt just failed: answer everything held except the
  // host's initialize, which keeps its full hold window so an app that is
  // still launching can serve the real handshake (retries continue
  // underneath it).
  drainPendingOnFailure() {
    const kept = [];
    const drained = [];
    for (const entry of this.pending) {
      if (entry.parsed.method === "initialize") {
        kept.push(entry);
      } else {
        clearTimeout(entry.timer);
        drained.push(entry);
      }
    }
    this.pending = kept;
    for (const entry of drained) {
      this.answerLocally(entry.parsed);
    }
  }

  noteDegraded(status, { quiet = false } = {}) {
    this.lastStatus = status;
    const key = `${status.status}:${status.message}`;
    if (!quiet && this.lastLoggedStatus !== key) {
      this.lastLoggedStatus = key;
      log(
        `bridge degraded (${status.status}): ${status.message} Retrying automatically.`
      );
    }
  }

  failInflight() {
    for (const id of this.inflight) {
      this.writeToClient({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message:
            "The local MCP connection to Recall was lost while this call " +
            "was in flight. The bridge reconnects automatically — check " +
            "whether the call took effect, then retry it.",
        },
      });
    }
    this.inflight.clear();
  }

  dropConnection(connection, reason) {
    if (this.connection !== connection) {
      return;
    }
    log(`closing helper connection: ${reason}`);
    connection.child.kill("SIGTERM");
  }

  // MARK: writing

  writeToHelper(raw) {
    const child = this.connection?.child;
    if (!child) {
      return;
    }
    const payload = raw[raw.length - 1] === 0x0a ? raw : Buffer.concat([raw, Buffer.from("\n")]);
    if (!child.stdin.write(payload) && !this.stdinPaused) {
      this.stdinPaused = true;
      process.stdin.pause();
      child.stdin.once("drain", () => {
        this.stdinPaused = false;
        process.stdin.resume();
      });
    }
  }

  writeToClient(value) {
    this.writeToClientRaw(Buffer.from(JSON.stringify(value)));
  }

  writeToClientRaw(raw) {
    const payload =
      raw[raw.length - 1] === 0x0a ? raw : Buffer.concat([raw, Buffer.from("\n")]);
    process.stdout.write(payload);
  }

  // MARK: lifecycle

  handleClientEnd() {
    if (this.clientClosed) {
      return;
    }
    this.clientClosed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const child = this.connection?.child;
    if (child && this.connection.phase === "ready") {
      // Half-close toward the app so in-flight responses still drain; the
      // helper exit handler finishes the process.
      child.stdin.end();
      return;
    }
    child?.kill("SIGTERM");
    process.exit(0);
  }

  handOffToOAuth() {
    // Replay everything the proxy consumed from stdin into the fallback so
    // the host's opening bytes survive the transport switch.
    const replay = [];
    if (this.clientInitialize) {
      replay.push(this.clientInitialize.raw);
    }
    if (this.clientSentInitialized) {
      replay.push(
        Buffer.from(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
        )
      );
    }
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      if (entry.parsed.method !== "initialize") {
        replay.push(entry.raw);
      }
    }
    this.pending = [];
    void runOAuthFallback(replay);
  }

  isReady() {
    return this.connection?.phase === "ready";
  }

  fatal(message) {
    log(message);
    process.exit(1);
  }
}

function checkPort() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForApp() {
  if (await checkPort()) return true;
  log(
    `Can't connect to the Recall MCP server on ${HOST}:${PORT} — ` +
      "the Recall Mac app is not running, or its MCP server is " +
      "disabled. Launch the app and enable Settings -> MCP Server; this " +
      "bridge will connect automatically."
  );
  const deadline = Date.now() + WAIT_FOR_APP_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (await checkPort()) {
      log("Recall is now reachable.");
      return true;
    }
  }
  return false;
}

async function discoverOAuthScope() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_METADATA_TIMEOUT_MS);
  try {
    const metadataUrl = new URL(
      "/.well-known/oauth-protected-resource/mcp",
      SERVER_URL
    );
    const response = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return oauthScopeForSupportedScopes(undefined);
    const metadata = await response.json();
    return oauthScopeForSupportedScopes(metadata?.scopes_supported);
  } catch {
    return oauthScopeForSupportedScopes(undefined);
  } finally {
    clearTimeout(timeout);
  }
}

// The legacy OAuth fallback: wait for the loopback listener, then hand stdio to
// the bundled mcp-remote proxy. Only reached when no socket-capable helper is
// installed, or the installed helper reports an unsupported protocol version.
// `replayLines` carries any bytes the socket path already consumed from stdin
// before handing off, so the host's opening requests survive the switch.
async function runOAuthFallback(replayLines = []) {
  // Name the chosen transport before doing anything else. Which path a session
  // took is the first question every bridge support thread asks, and it is
  // otherwise invisible: both paths speak the same MCP stdio to the host.
  log(`${TRANSPORT_MARKER} oauth-http`);
  const reachable = await waitForApp();
  if (!reachable) {
    log(
      `Gave up waiting for the Recall MCP server on ${SERVER_URL}. ` +
        "The Recall Mac app is not running (or its MCP server is " +
        "disabled in Settings). A locked screen does not cause this — the " +
        "server keeps working while the Mac is locked. Launch the app and " +
        "start a new conversation to retry."
    );
    process.exit(1);
  }

  const bundlePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "mcp-remote-proxy.bundle.mjs"
  );
  const oauthScope = await discoverOAuthScope();
  const child = spawn(
    process.execPath,
    proxyArgs(bundlePath, SERVER_URL, clientName, oauthScope),
    {
      env: {
        ...process.env,
        MCP_REMOTE_CONFIG_DIR: clientCacheDirectory(clientName),
      },
      stdio: [replayLines.length ? "pipe" : "inherit", "inherit", "inherit"],
    }
  );

  if (replayLines.length) {
    for (const line of replayLines) {
      child.stdin.write(line);
    }
    process.stdin.pipe(child.stdin);
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}

const helperPath = locateHelper();
if (helperPath) {
  log(`${TRANSPORT_MARKER} local-socket`);
  new ResilientLocalBridge(helperPath).start();
} else {
  // No socket-capable Recall is installed: the legacy OAuth path.
  await runOAuthFallback();
}
