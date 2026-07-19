#!/usr/bin/env node
// Stdio bridge to the Nerd Out Notes local MCP server.
//
// Claude clients treat plain-http URLs differently per surface: Claude Code
// connects to http://127.0.0.1:38473/mcp directly, but Claude Desktop's chat
// surface routes url-type MCP servers through cloud custom connectors, which
// require public HTTPS and can never reach a loopback listener. A stdio
// server has no URL, so every surface runs it locally. This wrapper waits for
// the Mac app's loopback server, then hands off to a bundled copy of
// mcp-remote (MIT, see LICENSE-mcp-remote.txt), which proxies stdio to
// streamable HTTP and runs the MCP OAuth flow (browser sign-in, token cache
// in ~/.mcp-auth, refresh) against the Nerd Out authorization server.

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SERVER_URL = "http://127.0.0.1:38473/mcp";
const HOST = "127.0.0.1";
const PORT = 38473;
const WAIT_FOR_APP_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

function log(message) {
  process.stderr.write(`[nerd-out-notes] ${message}\n`);
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
    `Can't connect to the Nerd Out Notes MCP server on ${HOST}:${PORT} — ` +
      "the Nerd Out Notes Mac app is not running, or its MCP server is " +
      "disabled. Launch the app and enable Settings -> MCP Server; this " +
      "bridge will connect automatically."
  );
  const deadline = Date.now() + WAIT_FOR_APP_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (await checkPort()) {
      log("Nerd Out Notes is now reachable.");
      return true;
    }
  }
  return false;
}

const reachable = await waitForApp();
if (!reachable) {
  log(
    `Gave up waiting for the Nerd Out Notes MCP server on ${SERVER_URL}. ` +
      "The Nerd Out Notes Mac app is not running (or its MCP server is " +
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
  [bundlePath, SERVER_URL, "--transport", "http-only"],
  { stdio: "inherit" }
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
