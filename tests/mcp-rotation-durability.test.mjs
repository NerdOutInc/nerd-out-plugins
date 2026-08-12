import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { proxyArgs, RECALL_OAUTH_SCOPE } from "../plugins/recall/bridge/client-identity.mjs";

// End-to-end regression tests for the 2026-08-12 production incident: the
// bridge refreshed (and therefore rotated) its OAuth refresh token against
// the authorization server, was shut down before the response was persisted,
// and the stranded rotated-out token later tripped the server's OAuth 2.1
// reuse detection, revoking the whole grant. These tests run the committed
// proxy bundle — the exact artifact the plugin ships — against a scripted
// authorization server.

const repoRoot = new URL("../", import.meta.url);
const bundlePath = fileURLToPath(
  new URL("plugins/recall/bridge/mcp-remote-proxy.bundle.mjs", repoRoot)
);
// The proxy pins its cache layout to the bundled mcp-remote version.
const MCP_REMOTE_VERSION = "0.1.38";

function authorizationServerMetadata(origin) {
  return {
    authorization_endpoint: `${origin}/oauth/authorize`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: origin,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    scopes_supported: ["notes:read", "notes:write"],
    token_endpoint: `${origin}/token`,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function respondJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A loopback MCP resource + authorization server. `handlers.onTokenRequest`
 * and `handlers.onRegisterRequest` let a test observe and script the token
 * and registration endpoints.
 */
async function startMockServer(handlers) {
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, origin);
    const unauthorized = () => {
      response.writeHead(401, {
        "WWW-Authenticate":
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      response.end();
    };

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      respondJson(response, 200, {
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource: `${origin}/mcp`,
        scopes_supported: ["notes:read", "notes:write"],
      });
    } else if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      respondJson(response, 200, authorizationServerMetadata(origin));
    } else if (url.pathname === "/token" && request.method === "POST") {
      await handlers.onTokenRequest(new URLSearchParams(await readBody(request)), response);
    } else if (url.pathname === "/register" && request.method === "POST") {
      await handlers.onRegisterRequest(JSON.parse(await readBody(request)), response);
    } else if (url.pathname === "/mcp" && request.method === "POST") {
      if (request.headers.authorization === "Bearer rotated-access") {
        await readBody(request);
        respondJson(response, 200, {
          id: 0,
          jsonrpc: "2.0",
          result: {
            capabilities: {},
            protocolVersion: "2025-03-26",
            serverInfo: { name: "mock", version: "0.0.0" },
          },
        });
      } else {
        unauthorized();
      }
    } else {
      unauthorized();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

function spawnProxy(serverUrl, cacheDirectory) {
  const child = spawn(
    process.execPath,
    proxyArgs(bundlePath, serverUrl, "Claude"),
    {
      env: { ...process.env, MCP_REMOTE_CONFIG_DIR: cacheDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}

test("a SIGTERM landing mid-rotation still persists the rotated tokens", async (t) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "recall-rotation-"));
  t.after(() => rm(cacheDirectory, { force: true, recursive: true }));

  let child;
  const { origin, server } = await startMockServer({
    onRegisterRequest: async (_payload, response) => respondJson(response, 500, {}),
    onTokenRequest: async (parameters, response) => {
      assert.equal(parameters.get("grant_type"), "refresh_token");
      assert.equal(parameters.get("refresh_token"), "old-refresh");
      // The rotation is now committed server-side. Shut the bridge down while
      // the response is still in flight — exactly the incident timing — and
      // deliver the rotated tokens only afterwards.
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      respondJson(response, 200, {
        access_token: "rotated-access",
        expires_in: 3600,
        refresh_token: "rotated-refresh",
        token_type: "bearer",
      });
    },
  });
  t.after(() => server.close());

  const serverUrl = `${origin}/mcp`;
  const hash = crypto.createHash("md5").update(serverUrl).digest("hex");
  const configDirectory = path.join(cacheDirectory, `mcp-remote-${MCP_REMOTE_VERSION}`);
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, `${hash}_client_info.json`),
    JSON.stringify({
      client_id: "seeded-client",
      redirect_uris: ["http://127.0.0.1:3999/oauth/callback"],
      scope: RECALL_OAUTH_SCOPE,
      token_endpoint_auth_method: "none",
    })
  );
  await writeFile(
    path.join(configDirectory, `${hash}_tokens.json`),
    JSON.stringify({
      access_token: "old-access",
      expires_in: 3600,
      refresh_token: "old-refresh",
      token_type: "bearer",
    })
  );

  const proxy = spawnProxy(serverUrl, cacheDirectory);
  child = proxy.child;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const { signal } = await proxy.exited;
  clearTimeout(timeout);

  assert.notEqual(signal, "SIGKILL", `proxy hung after SIGTERM:\n${proxy.stderr()}`);
  const persisted = JSON.parse(
    await readFile(path.join(configDirectory, `${hash}_tokens.json`), "utf8")
  );
  assert.equal(
    persisted.refresh_token,
    "rotated-refresh",
    `rotated refresh token was dropped:\n${proxy.stderr()}`
  );
  assert.equal(persisted.access_token, "rotated-access");
});

test("dynamic client registration presents the pinned 127.0.0.1 loopback form", async (t) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "recall-dcr-host-"));
  t.after(() => rm(cacheDirectory, { force: true, recursive: true }));

  let registration;
  const { origin, server } = await startMockServer({
    onRegisterRequest: async (payload, response) => {
      registration = payload;
      // Fail registration so the flow stops before opening a browser.
      respondJson(response, 500, {});
    },
    onTokenRequest: async (_parameters, response) => respondJson(response, 500, {}),
  });
  t.after(() => server.close());

  const proxy = spawnProxy(`${origin}/mcp`, cacheDirectory);
  const timeout = setTimeout(() => proxy.child.kill("SIGKILL"), 15_000);
  await proxy.exited;
  clearTimeout(timeout);

  assert.ok(registration, `registration request never arrived:\n${proxy.stderr()}`);
  assert.equal(registration.redirect_uris.length, 1);
  assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  assert.equal(registration.client_name, "Claude");
  assert.equal(registration.scope, RECALL_OAUTH_SCOPE);
});
