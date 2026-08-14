import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const coordinator = new URL(
  "plugins/recall/bridge/oauth-coordinator.bundle.mjs",
  repoRoot,
).pathname;
const proxy = new URL(
  "plugins/recall/bridge/mcp-remote-proxy.bundle.mjs",
  repoRoot,
).pathname;
const serverUrl = "http://127.0.0.1:38474/mcp";
const serverHash = createHash("md5").update(serverUrl).digest("hex");

const readBody = async (request) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
};

function createOAuthFixture({
  challengeHeader = 'Bearer scope=notes:read, resource_metadata="http://127.0.0.1:38474/.well-known/oauth-protected-resource/mcp"',
  challengeStatus = 401,
  metadataDelayMs = 0,
  refreshDelayMs = 0,
  registrationScopeResponse = "echo",
  scopesSupported = ["notes:read", "notes:write"],
  validAccessTokens = new Set(["access-1"]),
} = {}) {
  const counters = {
    authenticatedInitialize: 0,
    authenticatedToolsList: 0,
    authorizationCodeExchanges: 0,
    dynamicRegistrations: 0,
    refreshes: 0,
    registeredScopes: [],
    requests: 0,
  };
  let activeRefreshes = 0;
  let maximumConcurrentRefreshes = 0;
  let releaseMetadataStarted;
  let releaseRefreshStarted;
  const metadataStarted = new Promise((resolve) => {
    releaseMetadataStarted = resolve;
  });
  const refreshStarted = new Promise((resolve) => {
    releaseRefreshStarted = resolve;
  });

  const server = http.createServer(async (request, response) => {
    counters.requests += 1;
    const issuer = "http://127.0.0.1:38474";
    if (
      request.url === "/.well-known/oauth-protected-resource/mcp" ||
      request.url === "/.well-known/oauth-protected-resource"
    ) {
      releaseMetadataStarted();
      if (metadataDelayMs)
        await new Promise((resolve) => setTimeout(resolve, metadataDelayMs));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization_servers: [issuer],
          resource: serverUrl,
          scopes_supported: scopesSupported,
        }),
      );
      return;
    }
    if (
      request.url === "/.well-known/oauth-authorization-server" ||
      request.url === "/.well-known/openid-configuration"
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization_endpoint: `${issuer}/oauth/authorize`,
          grant_types_supported: ["authorization_code", "refresh_token"],
          issuer,
          registration_endpoint: `${issuer}/oauth/register`,
          response_types_supported: ["code"],
          scopes_supported: scopesSupported,
          token_endpoint: `${issuer}/oauth/token`,
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
      return;
    }
    if (request.url === "/oauth/register" && request.method === "POST") {
      counters.dynamicRegistrations += 1;
      const metadata = JSON.parse(await readBody(request));
      counters.registeredScopes.push(metadata.scope);
      const registration = { ...metadata, client_id: "phase1-client" };
      if (registrationScopeResponse === "omit") delete registration.scope;
      if (registrationScopeResponse === "narrow")
        registration.scope = "notes:read";
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(registration));
      return;
    }
    if (request.url === "/oauth/token" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        counters.authorizationCodeExchanges += 1;
      } else if (grantType === "refresh_token") {
        activeRefreshes += 1;
        maximumConcurrentRefreshes = Math.max(
          maximumConcurrentRefreshes,
          activeRefreshes,
        );
        counters.refreshes += 1;
        releaseRefreshStarted();
        if (refreshDelayMs)
          await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
        activeRefreshes -= 1;
      }
      const sequence = counters.authorizationCodeExchanges + counters.refreshes;
      validAccessTokens.add(`access-${sequence}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: `access-${sequence}`,
          expires_in: 300,
          refresh_token: `refresh-${sequence}`,
          token_type: "bearer",
        }),
      );
      return;
    }
    if (request.url === "/mcp" && request.method === "GET") {
      const accessToken = request.headers.authorization?.replace(
        /^Bearer /,
        "",
      );
      if (!accessToken || !validAccessTokens.has(accessToken)) {
        response.statusCode = challengeStatus;
        response.setHeader("www-authenticate", challengeHeader);
      } else {
        response.statusCode = 405;
      }
      response.end();
      return;
    }
    if (request.url === "/mcp" && request.method === "POST") {
      const accessToken = request.headers.authorization?.replace(
        /^Bearer /,
        "",
      );
      if (!accessToken || !validAccessTokens.has(accessToken)) {
        response.statusCode = challengeStatus;
        response.setHeader("www-authenticate", challengeHeader);
        response.end();
        return;
      }
      const message = JSON.parse(await readBody(request));
      if (message.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      const results = {
        initialize: {
          capabilities: { tools: {} },
          protocolVersion: "2025-03-26",
          serverInfo: { name: "recall-oauth-fixture", version: "1.0.0" },
        },
        "tools/list": { tools: [] },
      };
      if (message.method === "initialize")
        counters.authenticatedInitialize += 1;
      if (message.method === "tools/list") counters.authenticatedToolsList += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: results[message.method] ?? {},
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  return {
    counters,
    listen: () =>
      new Promise((resolve) => server.listen(38474, "127.0.0.1", resolve)),
    maximumConcurrentRefreshes: () => maximumConcurrentRefreshes,
    metadataStarted,
    refreshStarted,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function captureProcess(child) {
  const records = [];
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) records.push(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { records, stderr: () => stderr, stdout: () => stdout };
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

const waitForExit = (child) =>
  new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function makeHarness() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "recall-oauth-coordinator-"),
  );
  const sentinelDirectory = path.join(root, "bin");
  const sentinel = path.join(root, "browser-opened");
  await mkdir(sentinelDirectory);
  const opener = path.join(sentinelDirectory, "open");
  await writeFile(opener, `#!/bin/sh\ntouch '${sentinel}'\nexit 99\n`, {
    mode: 0o755,
  });
  await chmod(opener, 0o755);
  const environment = {
    ...process.env,
    MCP_REMOTE_CONFIG_DIR: root,
    PATH: `${sentinelDirectory}:${process.env.PATH}`,
  };
  return {
    cacheDirectory: path.join(root, "recall", "claude", "mcp-remote-0.1.38"),
    environment,
    root,
    sentinel,
  };
}

function spawnCoordinator(harness, mode) {
  return spawn(
    process.execPath,
    [
      coordinator,
      "--mode",
      mode,
      "--client-name",
      "Claude",
      "--server-url",
      serverUrl,
    ],
    { env: harness.environment, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function callbackForRecord(record, query) {
  const callback = new URL(record.callbackUrl);
  for (const [key, value] of Object.entries(query))
    callback.searchParams.set(key, value);
  return fetch(callback);
}

test("approve, reuse, inspect, denial, state mismatch, and cancel stay browserless and clean", async (t) => {
  const fixture = createOAuthFixture();
  await fixture.listen();
  t.after(() => fixture.stop());

  await t.test(
    "approval writes the exact cache and verify-only reuses it",
    async (subtest) => {
      const harness = await makeHarness();
      try {
        const approval = spawnCoordinator(harness, "authorize");
        subtest.after(() => stopProcess(approval));
        const approvalCapture = captureProcess(approval);
        const authorization = await waitFor(
          () =>
            approvalCapture.records.find(
              (record) => record.type === "authorization_required",
            ),
          `coordinator emitted no authorization request: ${approvalCapture.stderr()}`,
        );
        const authorizationUrl = new URL(authorization.authorizationUrl);
        assert.equal(
          fixture.counters.registeredScopes.at(-1),
          "notes:read notes:write",
        );
        const response = await callbackForRecord(authorization, {
          code: "approved-code",
          state: authorizationUrl.searchParams.get("state"),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await waitForExit(approval), {
          code: 0,
          signal: null,
        });
        assert.equal(
          approvalCapture.records.find((record) => record.type === "result")
            ?.status,
          "connected",
        );

        const files = await readdir(harness.cacheDirectory);
        const tokenFile = files.find((file) => file.endsWith("_tokens.json"));
        const clientFile = files.find((file) =>
          file.endsWith("_client_info.json"),
        );
        assert.ok(tokenFile);
        assert.ok(clientFile);
        assert.equal(
          (await stat(path.join(harness.cacheDirectory, tokenFile))).mode &
            0o777,
          0o600,
        );
        assert.equal(
          (await stat(path.join(harness.cacheDirectory, clientFile))).mode &
            0o777,
          0o600,
        );
        assert.equal(
          files.some(
            (file) => file.includes("verifier") || file.includes("lock"),
          ),
          false,
        );

        const requestsBeforeVerify = fixture.counters.requests;
        const verify = spawnCoordinator(harness, "verify-only");
        const verifyCapture = captureProcess(verify);
        assert.deepEqual(await waitForExit(verify), { code: 0, signal: null });
        assert.equal(
          verifyCapture.records.some(
            (record) => record.type === "authorization_required",
          ),
          false,
        );
        assert.equal(
          verifyCapture.records.find((record) => record.type === "result")
            ?.status,
          "connected",
        );
        assert.ok(fixture.counters.requests > requestsBeforeVerify);

        const foreignAuthLock = path.join(
          harness.cacheDirectory,
          `${serverHash}_lock.json`,
        );
        await writeFile(
          foreignAuthLock,
          JSON.stringify({
            pid: process.pid,
            port: 49_151,
            timestamp: Date.now(),
          }),
          { mode: 0o600 },
        );
        const verifyWithForeignLock = spawnCoordinator(harness, "verify-only");
        captureProcess(verifyWithForeignLock);
        assert.deepEqual(await waitForExit(verifyWithForeignLock), {
          code: 0,
          signal: null,
        });
        assert.equal((await stat(foreignAuthLock)).isFile(), true);
        await rm(foreignAuthLock);

        const requestsBeforeInspect = fixture.counters.requests;
        const inspect = spawnCoordinator(harness, "inspect");
        const inspectCapture = captureProcess(inspect);
        assert.deepEqual(await waitForExit(inspect), { code: 0, signal: null });
        assert.equal(inspectCapture.records.at(-1)?.status, "present");
        assert.equal(fixture.counters.requests, requestsBeforeInspect);
        assert.equal(
          await readFile(harness.sentinel)
            .then(() => true)
            .catch(() => false),
          false,
        );

        const captured = `${approvalCapture.stdout()}\n${approvalCapture.stderr()}\n${verifyCapture.stdout()}\n${verifyCapture.stderr()}`;
        assert.equal(
          ["access-1", "refresh-1", "approved-code"].some((secret) =>
            captured.includes(secret),
          ),
          false,
        );
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  await t.test(
    "a stale read-only client registration is rotated before authorization",
    async (subtest) => {
      const harness = await makeHarness();
      try {
        await mkdir(harness.cacheDirectory, { recursive: true });
        await Promise.all([
          writeFile(
            path.join(harness.cacheDirectory, `${serverHash}_client_info.json`),
            JSON.stringify({
              client_id: "stale-read-only-client",
              grant_types: ["authorization_code", "refresh_token"],
              redirect_uris: ["http://127.0.0.1:45678/oauth/callback"],
              response_types: ["code"],
              scope: "notes:read",
              token_endpoint_auth_method: "none",
            }),
            { mode: 0o600 },
          ),
          writeFile(
            path.join(harness.cacheDirectory, `${serverHash}_tokens.json`),
            JSON.stringify({
              access_token: "stale-access-token",
              refresh_token: "stale-refresh-token",
              token_type: "bearer",
            }),
            { mode: 0o600 },
          ),
        ]);

        const registrationsBefore = fixture.counters.dynamicRegistrations;
        const child = spawnCoordinator(harness, "authorize");
        subtest.after(() => stopProcess(child));
        const capture = captureProcess(child);
        const authorization = await waitFor(
          () =>
            capture.records.find(
              (record) => record.type === "authorization_required",
            ),
          `coordinator emitted no authorization request: ${capture.stderr()}`,
        );
        assert.equal(
          fixture.counters.dynamicRegistrations,
          registrationsBefore + 1,
        );
        assert.equal(
          fixture.counters.registeredScopes.at(-1),
          "notes:read notes:write",
        );
        assert.equal(
          new URL(authorization.authorizationUrl).searchParams.get("client_id"),
          "phase1-client",
        );
        assert.equal(authorization.clientId, "phase1-client");
        child.kill("SIGTERM");
        assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
        assert.equal(
          capture.records.find((record) => record.type === "result")?.status,
          "cancelled",
        );
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  await t.test(
    "verify-only reports but preserves a working read-only registration",
    async () => {
      const harness = await makeHarness();
      try {
        await mkdir(harness.cacheDirectory, { recursive: true });
        const clientPath = path.join(
          harness.cacheDirectory,
          `${serverHash}_client_info.json`,
        );
        const tokenPath = path.join(
          harness.cacheDirectory,
          `${serverHash}_tokens.json`,
        );
        await Promise.all([
          writeFile(
            clientPath,
            JSON.stringify({
              client_id: "working-read-only-client",
              grant_types: ["authorization_code", "refresh_token"],
              redirect_uris: ["http://127.0.0.1:45678/oauth/callback"],
              response_types: ["code"],
              scope: "notes:read",
              token_endpoint_auth_method: "none",
            }),
            { mode: 0o600 },
          ),
          writeFile(
            tokenPath,
            JSON.stringify({
              access_token: "access-1",
              refresh_token: "refresh-1",
              token_type: "bearer",
            }),
            { mode: 0o600 },
          ),
        ]);
        const registrationsBefore = fixture.counters.dynamicRegistrations;
        const requestsBefore = fixture.counters.requests;

        const child = spawnCoordinator(harness, "verify-only");
        const capture = captureProcess(child);
        assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
        assert.equal(capture.records.at(-1)?.status, "invalid");
        assert.equal(capture.records.at(-1)?.reason, "authorization-required");
        assert.equal(
          capture.records.some(
            (record) => record.type === "authorization_required",
          ),
          false,
        );
        assert.equal(
          fixture.counters.dynamicRegistrations,
          registrationsBefore,
        );
        // verify-only discovers the current resource scope before deciding
        // whether the cached registration is compatible, but never mutates it.
        assert.ok(fixture.counters.requests > requestsBefore);
        assert.equal(
          JSON.parse(await readFile(clientPath, "utf8")).client_id,
          "working-read-only-client",
        );
        assert.equal(
          JSON.parse(await readFile(tokenPath, "utf8")).access_token,
          "access-1",
        );
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  await t.test(
    "the browser bridge rotates a stale read-only client before opening consent",
    async (subtest) => {
      const harness = await makeHarness();
      try {
        await mkdir(harness.cacheDirectory, { recursive: true });
        const clientPath = path.join(
          harness.cacheDirectory,
          `${serverHash}_client_info.json`,
        );
        const tokenPath = path.join(
          harness.cacheDirectory,
          `${serverHash}_tokens.json`,
        );
        await Promise.all([
          writeFile(
            clientPath,
            JSON.stringify({
              client_id: "stale-browser-client",
              grant_types: ["authorization_code", "refresh_token"],
              redirect_uris: ["http://127.0.0.1:45678/oauth/callback"],
              response_types: ["code"],
              scope: "notes:read",
              token_endpoint_auth_method: "none",
            }),
            { mode: 0o600 },
          ),
          writeFile(
            tokenPath,
            JSON.stringify({
              access_token: "stale-browser-access",
              refresh_token: "stale-browser-refresh",
              token_type: "bearer",
            }),
            { mode: 0o600 },
          ),
        ]);
        const registrationsBefore = fixture.counters.dynamicRegistrations;
        const child = spawn(
          process.execPath,
          [
            proxy,
            serverUrl,
            "--allow-http",
            "--transport",
            "http-only",
            "--static-oauth-client-metadata",
            '{"client_name":"Claude","scope":"notes:read notes:write"}',
          ],
          {
            env: {
              ...harness.environment,
              MCP_REMOTE_CONFIG_DIR: path.join(
                harness.root,
                "recall",
                "claude",
              ),
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        subtest.after(() => stopProcess(child));
        const capture = captureProcess(child);

        await waitFor(
          () =>
            fixture.counters.dynamicRegistrations === registrationsBefore + 1,
          `browser bridge did not re-register: ${capture.stderr()}`,
        );
        await waitFor(
          () =>
            readFile(harness.sentinel)
              .then(() => true)
              .catch(() => false),
          `browser bridge did not reach consent: ${capture.stderr()}`,
        );
        const rotated = JSON.parse(await readFile(clientPath, "utf8"));
        assert.equal(rotated.client_id, "phase1-client");
        assert.equal(rotated.scope, "notes:read notes:write");
        await assert.rejects(readFile(tokenPath), /ENOENT/);
        await stopProcess(child);
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  await t.test(
    "denial completes promptly and cleans transient state",
    async (subtest) => {
      const harness = await makeHarness();
      try {
        const child = spawnCoordinator(harness, "authorize");
        subtest.after(() => stopProcess(child));
        const capture = captureProcess(child);
        const authorization = await waitFor(
          () =>
            capture.records.find(
              (record) => record.type === "authorization_required",
            ),
          `coordinator emitted no authorization request: ${capture.stderr()}`,
        );
        const state = new URL(authorization.authorizationUrl).searchParams.get(
          "state",
        );
        const response = await callbackForRecord(authorization, {
          error: "access_denied",
          state,
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
        assert.equal(
          capture.records.find((record) => record.type === "result")?.status,
          "denied",
        );
        const files = await readdir(harness.cacheDirectory);
        assert.equal(
          files.some(
            (file) =>
              file.includes("tokens") ||
              file.includes("verifier") ||
              file.includes("lock"),
          ),
          false,
        );
        assert.equal(
          await readFile(harness.sentinel)
            .then(() => true)
            .catch(() => false),
          false,
        );
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );

  await t.test(
    "wrong state remains pending until cancellation cleans it",
    async (subtest) => {
      const harness = await makeHarness();
      try {
        const child = spawnCoordinator(harness, "authorize");
        subtest.after(() => stopProcess(child));
        const capture = captureProcess(child);
        const authorization = await waitFor(
          () =>
            capture.records.find(
              (record) => record.type === "authorization_required",
            ),
          `coordinator emitted no authorization request: ${capture.stderr()}`,
        );
        const response = await callbackForRecord(authorization, {
          code: "wrong-state-code",
          state: "wrong-state",
        });
        assert.equal(response.status, 400);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          capture.records.some((record) => record.type === "result"),
          false,
        );
        child.kill("SIGTERM");
        assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
        assert.equal(
          capture.records.find((record) => record.type === "result")?.status,
          "cancelled",
        );
        const files = await readdir(harness.cacheDirectory);
        assert.equal(
          files.some(
            (file) =>
              file.includes("tokens") ||
              file.includes("verifier") ||
              file.includes("lock"),
          ),
          false,
        );
      } finally {
        await rm(harness.root, { force: true, recursive: true });
      }
    },
  );
});

test("journal read scope is requested only when the installed resource advertises it", async (t) => {
  const fixture = createOAuthFixture({
    scopesSupported: [
      "notes:read",
      "notes:write",
      "journal:read",
      "journal:write",
    ],
  });
  await fixture.listen();
  t.after(() => fixture.stop());
  const harness = await makeHarness();
  try {
    const child = spawnCoordinator(harness, "authorize");
    t.after(() => stopProcess(child));
    const capture = captureProcess(child);
    const authorization = await waitFor(
      () =>
        capture.records.find(
          (record) => record.type === "authorization_required",
        ),
      `coordinator emitted no authorization request: ${capture.stderr()}`,
    );
    const expectedScope = "notes:read notes:write journal:read";
    assert.equal(
      new URL(authorization.authorizationUrl).searchParams.get("scope"),
      expectedScope,
    );
    assert.equal(fixture.counters.registeredScopes.at(-1), expectedScope);

    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
    assert.equal(capture.records.at(-1)?.status, "cancelled");
  } finally {
    await rm(harness.root, { force: true, recursive: true });
  }
});

test("OAuth discovery finishes before the credential mutation lease is acquired", async (t) => {
  const fixture = createOAuthFixture({ metadataDelayMs: 500 });
  await fixture.listen();
  t.after(() => fixture.stop());
  const harness = await makeHarness();
  try {
    const child = spawnCoordinator(harness, "authorize");
    t.after(() => stopProcess(child));
    const capture = captureProcess(child);
    await fixture.metadataStarted;

    const credentialLock = path.join(
      harness.cacheDirectory,
      `${serverHash}_credentials.lock`,
    );
    assert.equal(
      await stat(credentialLock)
        .then(() => true)
        .catch(() => false),
      false,
      `discovery held the credential lease: ${capture.stderr()}`,
    );

    const authorization = await waitFor(
      () =>
        capture.records.find(
          (record) => record.type === "authorization_required",
        ),
      `coordinator emitted no authorization request: ${capture.stderr()}`,
    );
    assert.ok(authorization.authorizationUrl);
    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
  } finally {
    await rm(harness.root, { force: true, recursive: true });
  }
});

for (const registrationScopeResponse of ["omit", "narrow"]) {
  test(`authorization-code exchange survives a DCR response that ${registrationScopeResponse}s scope`, async (t) => {
    const fixture = createOAuthFixture({ registrationScopeResponse });
    await fixture.listen();
    t.after(() => fixture.stop());
    const harness = await makeHarness();
    try {
      const child = spawnCoordinator(harness, "authorize");
      t.after(() => stopProcess(child));
      const capture = captureProcess(child);
      const authorization = await waitFor(
        () =>
          capture.records.find(
            (record) => record.type === "authorization_required",
          ),
        `coordinator emitted no authorization request: ${capture.stderr()}`,
      );
      const authorizationUrl = new URL(authorization.authorizationUrl);
      assert.equal(
        authorizationUrl.searchParams.get("scope"),
        "notes:read notes:write",
      );
      assert.equal(
        fixture.counters.registeredScopes.at(-1),
        "notes:read notes:write",
      );

      const response = await callbackForRecord(authorization, {
        code: `${registrationScopeResponse}-scope-code`,
        state: authorizationUrl.searchParams.get("state"),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
      assert.equal(capture.records.at(-1)?.status, "connected");
      assert.equal(fixture.counters.authorizationCodeExchanges, 1);

      const savedClient = JSON.parse(
        await readFile(
          path.join(harness.cacheDirectory, `${serverHash}_client_info.json`),
          "utf8",
        ),
      );
      assert.equal(savedClient.client_id, "phase1-client");
      assert.equal(
        savedClient.scope,
        registrationScopeResponse === "omit"
          ? "notes:read notes:write"
          : "notes:read",
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(harness.cacheDirectory, `${serverHash}_tokens.json`),
            "utf8",
          ),
        ).access_token,
        "access-1",
      );
      assert.equal(
        (await readdir(harness.cacheDirectory)).some(
          (file) => file.includes("verifier") || file.includes("lock"),
        ),
        false,
      );
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });
}

test("403 insufficient_scope challenges are widened before reauthorization", async (t) => {
  const fixture = createOAuthFixture({
    challengeHeader:
      'Bearer error="insufficient_scope", scope="notes:write", resource_metadata="http://127.0.0.1:38474/.well-known/oauth-protected-resource/mcp"',
    challengeStatus: 403,
  });
  await fixture.listen();
  t.after(() => fixture.stop());
  const harness = await makeHarness();
  try {
    const child = spawnCoordinator(harness, "authorize");
    t.after(() => stopProcess(child));
    const capture = captureProcess(child);
    const authorization = await waitFor(
      () =>
        capture.records.find(
          (record) => record.type === "authorization_required",
        ),
      `coordinator emitted no authorization request: ${capture.stderr()}`,
    );
    assert.equal(
      new URL(authorization.authorizationUrl).searchParams.get("scope"),
      "notes:read notes:write",
    );
    assert.equal(
      fixture.counters.registeredScopes.at(-1),
      "notes:read notes:write",
    );

    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
    assert.equal(capture.records.at(-1)?.status, "cancelled");
  } finally {
    await rm(harness.root, { force: true, recursive: true });
  }
});

test("verify-only serializes behind a live bridge that is already mid-refresh", async (t) => {
  const fixture = createOAuthFixture({
    refreshDelayMs: 600,
    validAccessTokens: new Set(),
  });
  await fixture.listen();
  t.after(() => fixture.stop());
  const harness = await makeHarness();
  try {
    await mkdir(harness.cacheDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(harness.cacheDirectory, `${serverHash}_client_info.json`),
        JSON.stringify({
          client_id: "phase1-client",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://127.0.0.1:45678/oauth/callback"],
          response_types: ["code"],
          scope: "notes:read notes:write",
          token_endpoint_auth_method: "none",
        }),
        { mode: 0o600 },
      ),
      writeFile(
        path.join(harness.cacheDirectory, `${serverHash}_tokens.json`),
        JSON.stringify({
          access_token: "access-0",
          expires_in: 300,
          refresh_token: "refresh-0",
          token_type: "bearer",
        }),
        { mode: 0o600 },
      ),
    ]);

    const live = spawn(
      process.execPath,
      [
        proxy,
        serverUrl,
        "--allow-http",
        "--transport",
        "http-only",
        "--static-oauth-client-metadata",
        '{"client_name":"Claude","scope":"notes:read notes:write"}',
      ],
      {
        env: {
          ...harness.environment,
          MCP_REMOTE_CONFIG_DIR: path.join(harness.root, "recall", "claude"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => stopProcess(live));
    const liveCapture = captureProcess(live);
    live.stdin.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "phase1-live-bridge", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      })}\n`,
    );

    await Promise.race([
      fixture.refreshStarted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("live bridge never began refresh")),
          10_000,
        ),
      ),
    ]);
    const verify = spawnCoordinator(harness, "verify-only");
    const verifyCapture = captureProcess(verify);
    assert.deepEqual(await waitForExit(verify), { code: 0, signal: null });
    assert.equal(verifyCapture.records.at(-1)?.status, "connected");
    await waitFor(
      () => liveCapture.stdout().includes('"id":1'),
      `live bridge never recovered: ${liveCapture.stderr()}`,
    );
    live.kill("SIGTERM");
    await waitForExit(live);

    const savedTokens = JSON.parse(
      await readFile(
        path.join(harness.cacheDirectory, `${serverHash}_tokens.json`),
        "utf8",
      ),
    );
    const captured = `${liveCapture.stdout()}\n${liveCapture.stderr()}\n${verifyCapture.stdout()}\n${verifyCapture.stderr()}`;
    assert.equal(fixture.counters.refreshes, 1);
    assert.equal(fixture.maximumConcurrentRefreshes(), 1);
    assert.equal(savedTokens.refresh_token, "refresh-1");
    assert.equal(
      (
        await stat(
          path.join(harness.cacheDirectory, `${serverHash}_tokens.json`),
        )
      ).mode & 0o777,
      0o600,
    );
    assert.equal(
      ["access-0", "access-1", "refresh-0", "refresh-1"].some((secret) =>
        captured.includes(secret),
      ),
      false,
    );
    assert.equal(
      await readFile(harness.sentinel)
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await rm(harness.root, { force: true, recursive: true });
  }
});
