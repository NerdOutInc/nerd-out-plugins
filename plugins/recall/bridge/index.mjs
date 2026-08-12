#!/usr/bin/env node
// Stdio bridge to Recall's local MCP server (v2).
//
// Preferred path — the app-issued local socket: Recall.app ships a
// Recall-SIGNED helper (recall-mcp-bridge) in Contents/Helpers. When it's on
// disk, this supervisor execs it and pumps MCP stdio straight through; the
// helper connects to a Unix socket in Recall's app-group container, the app
// verifies the helper's code signature and the signed-in user's one-time
// consent, and serves MCP over the socket. No browser, no DCR, no tokens on
// disk — nothing for this bridge to refresh or lose. See
// recall-app docs/mcp-app-issued-credentials-plan.md.
//
// Fallback path — legacy OAuth: when the helper is ABSENT (an older Recall
// that predates the socket) or reports an UNSUPPORTED protocol version, this
// wrapper falls back to a bundled copy of mcp-remote (MIT, see
// LICENSE-mcp-remote.txt), which proxies stdio to the loopback HTTP listener
// and runs the MCP OAuth flow (browser sign-in, token cache in ~/.mcp-auth,
// refresh) against the Recall authorization server. Every OTHER helper outcome
// — denied/revoked/pending consent, signed out, wrong account, a bad
// signature, a protocol error — is surfaced to the MCP client as an error and
// NEVER silently downgraded to OAuth: an auto-respawning host would otherwise
// turn one Deny into a prompt storm, and a spoofed downgrade would defeat the
// consent the user just made.
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
  parseClientName,
  proxyArgs,
} from "./client-identity.mjs";

const SERVER_URL = "http://127.0.0.1:38473/mcp";
const HOST = "127.0.0.1";
const PORT = 38473;
const WAIT_FOR_APP_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

// The helper's exit-code contract (recall-app apple-app/McpBridgeSources).
const HELPER_EXIT = {
  cleanEOF: 0,
  socketUnavailable: 64, // app not running / MCP disabled — retry, then error
  unsupportedVersion: 65, // no protocol overlap — OAuth fallback permitted
  refused: 66, // denied/revoked/pending/signed-out/mismatch/unauth — surface
  protocolError: 70, // malformed handshake — surface, never OAuth
};

// Candidate locations for the Recall-signed helper inside an installed
// Recall.app. The plugin can't know the exact bundle path, so it checks the
// standard install locations for both the release and dev bundles; a
// RECALL_MCP_BRIDGE override wins for testing.
const HELPER_RELATIVE_PATH = "Contents/Helpers/recall-mcp-bridge";

// Prefix for the one-line "which transport did this session use" marker. Both
// paths speak identical MCP stdio to the host, so without this the choice is
// invisible in a host's MCP log.
const TRANSPORT_MARKER = "transport:";

function log(message) {
  process.stderr.write(`[recall] ${message}\n`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Spawn the helper once and resolve with its exit code. stdio is inherited, so
// MCP bytes flow straight between the host and the helper; the helper never
// reads stdin before an approved handshake, so a retry/fallback after a
// non-zero exit loses no MCP data.
function runHelper(helperPath) {
  return new Promise((resolve) => {
    const child = spawn(helperPath, ["--client-name", clientName], {
      stdio: "inherit",
    });
    const forward = (signal) => child.kill(signal);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      process.on(signal, forward);
    }
    child.on("error", () => resolve(HELPER_EXIT.socketUnavailable));
    child.on("exit", (code, signal) => {
      for (const s of signals) {
        process.off(s, forward);
      }
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

// Drive the helper with the same wait-for-app patience the HTTP path uses: a
// `socketUnavailable` exit means Recall isn't running yet (its own connect
// already failed), so retry until the deadline. Returns the terminal exit
// code, or `unsupportedVersion` to signal an OAuth fallback.
async function runHelperWithWait(helperPath) {
  const deadline = Date.now() + WAIT_FOR_APP_MS;
  let announcedWait = false;
  while (true) {
    const code = await runHelper(helperPath);
    if (code !== HELPER_EXIT.socketUnavailable) {
      return code;
    }
    if (Date.now() >= deadline) {
      return code;
    }
    if (!announcedWait) {
      log(
        "Waiting for the Recall Mac app — it isn't running, or its MCP " +
          "server is disabled in Settings. A locked screen does not cause " +
          "this. Launch Recall; this bridge will connect automatically."
      );
      announcedWait = true;
    }
    await delay(POLL_INTERVAL_MS);
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

// The legacy OAuth fallback: wait for the loopback listener, then hand stdio to
// the bundled mcp-remote proxy. Only reached when no socket-capable helper is
// installed, or the installed helper reports an unsupported protocol version.
async function runOAuthFallback() {
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
  const child = spawn(
    process.execPath,
    proxyArgs(bundlePath, SERVER_URL, clientName),
    {
      env: {
        ...process.env,
        MCP_REMOTE_CONFIG_DIR: clientCacheDirectory(clientName),
      },
      stdio: "inherit",
    }
  );

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
  const code = await runHelperWithWait(helperPath);
  if (code === HELPER_EXIT.unsupportedVersion) {
    // The installed Recall is older than this bridge's protocol; the legacy
    // OAuth path still reaches the same app.
    log("Recall's local bridge protocol is older than this plugin; using OAuth.");
    await runOAuthFallback();
  } else {
    // Clean EOF, a surfaced refusal (the helper already printed the reason),
    // or a protocol error: propagate. Never fall back to OAuth here — doing so
    // would re-prompt past a Deny or paper over a failed signature check.
    process.exit(code);
  }
} else {
  // No socket-capable Recall is installed: the legacy OAuth path.
  await runOAuthFallback();
}
