#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  clientCacheDirectory,
  RECALL_LOOPBACK_HOST,
  RECALL_OAUTH_SCOPE,
} from "../../client-identity.mjs";
import { createLazyAuthCoordinator } from "../vendor/mcp-remote/src/lib/coordination";
import {
  acquireCredentialMutationLock,
  CredentialCacheBusyError,
  deleteLockfile,
  getConfigFilePath,
  type CredentialMutationLease,
} from "../vendor/mcp-remote/src/lib/mcp-auth-config";
import {
  CoordinatedNodeOAuthClientProvider,
  sameScopeSet,
} from "../vendor/mcp-remote/src/lib/coordinated-node-oauth-client-provider";
import {
  connectToRemoteServer,
  discoverOAuthServerInfo,
  findAvailablePort,
  getServerUrlHash,
  MCP_REMOTE_VERSION,
} from "../vendor/mcp-remote/src/lib/utils";

export const AUTHORIZATION_CONTRACT_VERSION = 1;
export const COORDINATOR_TIMEOUT_MS = 2 * 60 * 1_000;
export const MCP_SERVER_URLS = [
  "http://127.0.0.1:38473/mcp",
  "http://127.0.0.1:38474/mcp",
] as const;
export const SUPPORTED_CLIENTS = ["Claude", "Codex"] as const;

type CoordinatorMode = "authorize" | "inspect" | "verify-only";
type SupportedClient = (typeof SUPPORTED_CLIENTS)[number];
type McpServerUrl = (typeof MCP_SERVER_URLS)[number];
type CacheState = "missing" | "present" | "unknown";

export interface CoordinatorArguments {
  clientName: SupportedClient;
  mode: CoordinatorMode;
  serverUrl: McpServerUrl;
}

interface CacheSnapshot {
  clientId: null | string;
  state: CacheState;
}

interface CoordinatorRecord {
  authorizationUrl?: string;
  callbackUrl?: string;
  clientId?: null | string;
  mode: CoordinatorMode;
  protocolVersion: number;
  reason?: string;
  sequence: number;
  status?: string;
  type: "authorization_required" | "result" | "status";
}

class AuthorizationRequiredError extends Error {
  constructor() {
    super("Authorization is required");
    this.name = "AuthorizationRequiredError";
  }
}

let sequence = 0;
let resultWritten = false;

export function parseCoordinatorArguments(args: string[]): CoordinatorArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Expected --mode, --client-name, and optional --server-url values");
    }
    if (values.has(flag)) throw new Error(`${flag} may only be supplied once`);
    values.set(flag, value);
  }

  for (const flag of values.keys()) {
    if (!["--client-name", "--mode", "--server-url"].includes(flag)) {
      throw new Error(`Unsupported coordinator option: ${flag}`);
    }
  }

  const mode = values.get("--mode");
  const clientName = values.get("--client-name");
  const serverUrl = values.get("--server-url") ?? MCP_SERVER_URLS[0];
  if (!["authorize", "inspect", "verify-only"].includes(mode ?? "")) {
    throw new Error("Unsupported coordinator mode");
  }
  if (!SUPPORTED_CLIENTS.includes(clientName as SupportedClient)) {
    throw new Error("Unsupported coordinator client");
  }
  if (!MCP_SERVER_URLS.includes(serverUrl as McpServerUrl)) {
    throw new Error("Unsupported MCP server URL");
  }
  return {
    clientName: clientName as SupportedClient,
    mode: mode as CoordinatorMode,
    serverUrl: serverUrl as McpServerUrl,
  };
}

function writeRecord(record: Omit<CoordinatorRecord, "protocolVersion" | "sequence">): void {
  const complete: CoordinatorRecord = {
    ...record,
    protocolVersion: AUTHORIZATION_CONTRACT_VERSION,
    sequence: ++sequence,
  };
  const serialized = JSON.stringify(complete);
  if (serialized.length > 16_384) throw new Error("Coordinator record exceeds size limit");
  process.stdout.write(`${serialized}\n`);
  if (record.type === "result") resultWritten = true;
}

async function readValidatedJson(
  filePath: string,
  schema: { parseAsync(value: unknown): Promise<unknown> }
) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return { exists: true, value: await schema.parseAsync(value) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, value: undefined };
    }
    return { exists: true, value: undefined };
  }
}

export async function inspectCache(serverUrlHash: string): Promise<CacheSnapshot> {
  const [client, tokens] = await Promise.all([
    readValidatedJson(
      getConfigFilePath(serverUrlHash, "client_info.json"),
      OAuthClientInformationFullSchema
    ),
    readValidatedJson(getConfigFilePath(serverUrlHash, "tokens.json"), OAuthTokensSchema),
  ]);
  const clientId =
    client.value && typeof (client.value as { client_id?: unknown }).client_id === "string"
      ? (client.value as { client_id: string }).client_id
      : null;
  if (!client.exists && !tokens.exists) return { clientId: null, state: "missing" };
  if ((client.exists && !client.value) || (tokens.exists && !tokens.value)) {
    return { clientId, state: "unknown" };
  }
  if (!client.value || !tokens.value || !clientId) return { clientId, state: "missing" };
  return { clientId, state: "present" };
}

async function readConfiguredCallbackPort(serverUrlHash: string): Promise<number | undefined> {
  const client = await readValidatedJson(
    getConfigFilePath(serverUrlHash, "client_info.json"),
    OAuthClientInformationFullSchema
  );
  if (!client.value) return undefined;
  const redirectUris = (client.value as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(redirectUris)) return undefined;
  for (const redirectUri of redirectUris) {
    if (typeof redirectUri !== "string") continue;
    try {
      const parsed = new URL(redirectUri);
      if (
        parsed.protocol === "http:" &&
        // `localhost` covers registrations written before the proxy pinned
        // RECALL_LOOPBACK_HOST; reusing their port keeps the cache coherent.
        (parsed.hostname === RECALL_LOOPBACK_HOST || parsed.hostname === "localhost") &&
        parsed.pathname === "/oauth/callback" &&
        parsed.port
      ) {
        return Number(parsed.port);
      }
    } catch {
      // Ignore malformed cached redirect URIs; inspect reports invalid elsewhere.
    }
  }
  return undefined;
}

function defaultCallbackPort(serverUrlHash: string): number {
  const offset = Number.parseInt(serverUrlHash.slice(0, 4), 16);
  return 3335 + (offset % 45_816);
}

async function cachedClientHasScope(
  serverUrlHash: string,
  requiredScope: string
): Promise<boolean> {
  const client = await readValidatedJson(
    getConfigFilePath(serverUrlHash, "client_info.json"),
    OAuthClientInformationFullSchema
  );
  const scope =
    client.value && typeof (client.value as { scope?: unknown }).scope === "string"
      ? (client.value as { scope: string }).scope
      : undefined;
  return sameScopeSet(scope, requiredScope);
}

export function validateAuthorizationUrl(
  authorizationUrl: URL,
  authorizationServerUrl: string,
  callbackUrl: string,
  expectedState: string,
  serverUrl: McpServerUrl
): void {
  const expectedOrigin = new URL(authorizationServerUrl).origin;
  if (
    authorizationUrl.origin !== expectedOrigin ||
    authorizationUrl.pathname !== "/oauth/authorize" ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.hash ||
    authorizationUrl.toString().length > 8_192
  ) {
    throw new Error("Authorization URL failed origin or shape validation");
  }

  const expected = new Map<string, string>([
    ["redirect_uri", callbackUrl],
    ["resource", serverUrl],
    ["response_type", "code"],
    ["state", expectedState],
    ["code_challenge_method", "S256"],
  ]);
  for (const [name, value] of expected) {
    if (
      authorizationUrl.searchParams.getAll(name).length !== 1 ||
      authorizationUrl.searchParams.get(name) !== value
    ) {
      throw new Error(`Authorization URL failed ${name} validation`);
    }
  }

  const clientIds = authorizationUrl.searchParams.getAll("client_id");
  if (clientIds.length !== 1 || !clientIds[0]) {
    throw new Error("Authorization URL failed client_id validation");
  }
  const challenges = authorizationUrl.searchParams.getAll("code_challenge");
  if (challenges.length !== 1 || !challenges[0]) {
    throw new Error("Authorization URL failed PKCE validation");
  }
  const scopes = authorizationUrl.searchParams.getAll("scope");
  const scopeItems = scopes[0]?.split(" ").filter(Boolean) ?? [];
  if (
    scopes.length !== 1 ||
    scopeItems.length !== 2 ||
    new Set(scopeItems).size !== 2 ||
    !scopeItems.includes("notes:read") ||
    !scopeItems.includes("notes:write")
  ) {
    throw new Error("Authorization URL failed scope validation");
  }
}

async function runNetworkedMode(args: CoordinatorArguments): Promise<void> {
  const serverUrlHash = getServerUrlHash(args.serverUrl);
  let credentialLease: CredentialMutationLease | undefined;
  let provider: CoordinatedNodeOAuthClientProvider | undefined;
  let client: Client | undefined;
  let callbackServer: Server | undefined;
  let ownsAuthLock = false;
  let finishing = false;

  const cleanup = async () => {
    await provider?.invalidateCredentials("verifier");
    await provider?.releaseCredentialLease();
    await credentialLease?.release();
    await client?.close().catch(() => undefined);
    callbackServer?.close();
    if (ownsAuthLock) await deleteLockfile(serverUrlHash);
  };
  const terminate = async (reason: "cancelled" | "timeout") => {
    if (finishing) return;
    finishing = true;
    // A refresh rotation may be mid-flight; let it persist before the cache
    // is inspected for the result record and the lease is force-released.
    await provider?.waitForCredentialMutationQuiescence();
    if (!resultWritten) {
      writeRecord({
        clientId: (await inspectCache(serverUrlHash)).clientId,
        mode: args.mode,
        reason,
        status: reason === "cancelled" ? "cancelled" : "unknown",
        type: "result",
      });
    }
    await cleanup();
    process.exit(0);
  };
  const timeout = setTimeout(() => void terminate("timeout"), COORDINATOR_TIMEOUT_MS);
  const cancel = () => void terminate("cancelled");
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    credentialLease = await acquireCredentialMutationLock(serverUrlHash, COORDINATOR_TIMEOUT_MS);
    const configuredPort = await readConfiguredCallbackPort(serverUrlHash);
    let callbackPort = configuredPort ?? defaultCallbackPort(serverUrlHash);
    if (args.mode === "authorize") {
      const availablePort = await findAvailablePort(callbackPort);
      if (configuredPort && availablePort !== configuredPort) {
        throw new CredentialCacheBusyError();
      }
      callbackPort = availablePort;
    }
    const callbackUrl = `http://${RECALL_LOOPBACK_HOST}:${callbackPort}/oauth/callback`;
    const discovery = await discoverOAuthServerInfo(args.serverUrl, {});
    provider = new CoordinatedNodeOAuthClientProvider(
      {
        authorizeResource: args.serverUrl,
        authorizationServerMetadata: discovery.authorizationServerMetadata,
        callbackPort,
        clientName: args.clientName,
        host: RECALL_LOOPBACK_HOST,
        protectedResourceMetadata: discovery.protectedResourceMetadata,
        requiredClientScope: args.mode === "authorize" ? RECALL_OAUTH_SCOPE : undefined,
        serverUrl: discovery.authorizationServerUrl,
        serverUrlHash,
        staticOAuthClientMetadata: {
          client_name: args.clientName,
          redirect_uris: [callbackUrl],
          scope: RECALL_OAUTH_SCOPE,
        },
        wwwAuthenticateScope: discovery.wwwAuthenticateScope,
      },
      credentialLease
    );
    credentialLease = undefined;

    const events = new EventEmitter();
    const authCoordinator = createLazyAuthCoordinator(
      serverUrlHash,
      callbackPort,
      events,
      COORDINATOR_TIMEOUT_MS,
      provider.state()
    );
    const initializeAuth = async () => {
      const initialized = await authCoordinator.initializeAuth();
      callbackServer = initialized.server;
      ownsAuthLock = !initialized.skipBrowserAuth;
      return initialized;
    };
    let authState: Awaited<ReturnType<typeof authCoordinator.initializeAuth>> | undefined;
    if (args.mode === "authorize") {
      authState = await initializeAuth();
    }

    provider.options.authorizationUrlHandler = async (authorizationUrl) => {
      if (args.mode === "verify-only") throw new AuthorizationRequiredError();
      validateAuthorizationUrl(
        authorizationUrl,
        discovery.authorizationServerUrl,
        callbackUrl,
        provider!.state(),
        args.serverUrl
      );
      writeRecord({
        authorizationUrl: authorizationUrl.toString(),
        callbackUrl,
        clientId: (await inspectCache(serverUrlHash)).clientId,
        mode: args.mode,
        status: "awaiting-consent",
        type: "authorization_required",
      });
    };

    const authInitializer = async () => {
      if (args.mode === "verify-only") throw new AuthorizationRequiredError();
      authState ??= await initializeAuth();
      return {
        skipBrowserAuth: authState.skipBrowserAuth,
        waitForAuthCode: authState.waitForAuthCode,
      };
    };

    client = new Client(
      { name: "recall-oauth-coordinator", version: MCP_REMOTE_VERSION },
      { capabilities: {} }
    );
    const transport = await connectToRemoteServer(
      client,
      args.serverUrl,
      provider,
      {},
      authInitializer,
      "http-only"
    );
    await client.request({ method: "tools/list" }, ListToolsResultSchema);
    await transport.close().catch(() => undefined);
    const connected = await inspectCache(serverUrlHash);
    writeRecord({
      clientId: connected.clientId,
      mode: args.mode,
      status: "connected",
      type: "result",
    });
  } catch (error) {
    const connected = await inspectCache(serverUrlHash);
    if (error instanceof CredentialCacheBusyError) {
      writeRecord({
        clientId: connected.clientId,
        mode: args.mode,
        reason: "busy",
        status: "unknown",
        type: "result",
      });
    } else if (error instanceof AuthorizationRequiredError) {
      writeRecord({
        clientId: connected.clientId,
        mode: args.mode,
        reason: "authorization-required",
        status: "invalid",
        type: "result",
      });
    } else if (error instanceof Error && error.message.includes("access_denied")) {
      writeRecord({
        clientId: connected.clientId,
        mode: args.mode,
        reason: "access-denied",
        status: "denied",
        type: "result",
      });
    } else {
      writeRecord({
        clientId: connected.clientId,
        mode: args.mode,
        reason: "unavailable",
        status: "unknown",
        type: "result",
      });
    }
  } finally {
    finishing = true;
    clearTimeout(timeout);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await cleanup();
  }
}

export async function runCoordinator(args: CoordinatorArguments): Promise<void> {
  process.env.MCP_REMOTE_CONFIG_DIR = clientCacheDirectory(args.clientName);
  const serverUrlHash = getServerUrlHash(args.serverUrl);
  const snapshot = await inspectCache(serverUrlHash);
  writeRecord({
    clientId: snapshot.clientId,
    mode: args.mode,
    status: snapshot.state,
    type: "status",
  });
  if (args.mode === "inspect") {
    writeRecord({
      clientId: snapshot.clientId,
      mode: args.mode,
      status: snapshot.state,
      type: "result",
    });
    return;
  }
  if (args.mode === "verify-only" && snapshot.state !== "present") {
    writeRecord({
      clientId: snapshot.clientId,
      mode: args.mode,
      status: snapshot.state,
      type: "result",
    });
    return;
  }
  if (
    args.mode === "verify-only" &&
    !(await cachedClientHasScope(serverUrlHash, RECALL_OAUTH_SCOPE))
  ) {
    writeRecord({
      clientId: snapshot.clientId,
      mode: args.mode,
      reason: "authorization-required",
      status: "invalid",
      type: "result",
    });
    return;
  }

  await runNetworkedMode(args);
}

async function main(): Promise<void> {
  try {
    await runCoordinator(parseCoordinatorArguments(process.argv.slice(2)));
    process.exit(resultWritten ? 0 : 1);
  } catch {
    if (!resultWritten) {
      writeRecord({
        mode: "inspect",
        reason: "invalid-request",
        status: "failed",
        type: "result",
      });
    }
    process.exit(2);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
