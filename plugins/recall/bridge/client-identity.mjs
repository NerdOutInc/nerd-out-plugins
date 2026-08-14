import os from "node:os";
import path from "node:path";

export const DEFAULT_CLIENT_NAME = "Recall MCP Client";
export const RECALL_LEGACY_OAUTH_SCOPE = "notes:read notes:write";
export const RECALL_PROJECT_CONTEXT_OAUTH_SCOPE =
  "notes:read notes:write journal:read";
// Backward-compatible name for callers that have not performed protected-
// resource discovery. Older Recall builds understand exactly these scopes.
export const RECALL_OAUTH_SCOPE = RECALL_LEGACY_OAUTH_SCOPE;
// The single loopback host form every Recall OAuth surface registers AND
// presents. mcp-remote's own default is `localhost` while its callback
// listener binds 127.0.0.1, so a registration written by one flow can
// mismatch the authorize request built by another; one shared constant keeps
// the proxy and the in-app coordinator byte-identical here.
export const RECALL_LOOPBACK_HOST = "127.0.0.1";
const CLIENT_NAME_FLAG = "--client-name";
const MAX_CLIENT_NAME_LENGTH = 100;

/**
 * Select the narrowest useful Recall OAuth scope from the local app's
 * protected-resource metadata. The notes pair is the compatibility floor.
 * Journal access is additive only when the resource explicitly advertises it;
 * a malformed or partial response therefore cannot break older Recall builds.
 */
export function oauthScopeForSupportedScopes(scopesSupported) {
  if (!Array.isArray(scopesSupported)) return RECALL_LEGACY_OAUTH_SCOPE;

  const supported = new Set(
    scopesSupported.filter((scope) => typeof scope === "string")
  );
  if (!supported.has("notes:read") || !supported.has("notes:write")) {
    return RECALL_LEGACY_OAUTH_SCOPE;
  }

  return supported.has("journal:read")
    ? RECALL_PROJECT_CONTEXT_OAUTH_SCOPE
    : RECALL_LEGACY_OAUTH_SCOPE;
}

export function parseClientName(args) {
  const flagIndex = args.indexOf(CLIENT_NAME_FLAG);
  if (flagIndex === -1) return DEFAULT_CLIENT_NAME;

  if (args.indexOf(CLIENT_NAME_FLAG, flagIndex + 1) !== -1) {
    throw new Error(`${CLIENT_NAME_FLAG} may only be supplied once.`);
  }

  const clientName = args[flagIndex + 1]?.trim();
  if (!clientName || clientName.startsWith("-")) {
    throw new Error(`${CLIENT_NAME_FLAG} requires a non-empty value.`);
  }
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw new Error(
      `${CLIENT_NAME_FLAG} must be ${MAX_CLIENT_NAME_LENGTH} characters or fewer.`
    );
  }

  return clientName;
}

export function clientCacheDirectory(
  clientName,
  baseDirectory =
    process.env.MCP_REMOTE_CONFIG_DIR ?? path.join(os.homedir(), ".mcp-auth")
) {
  const slug =
    clientName
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "mcp-client";

  return path.join(baseDirectory, "recall", slug);
}

export function proxyArgs(
  bundlePath,
  serverUrl,
  clientName,
  oauthScope = RECALL_LEGACY_OAUTH_SCOPE
) {
  return [
    bundlePath,
    serverUrl,
    "--transport",
    "http-only",
    "--host",
    RECALL_LOOPBACK_HOST,
    "--static-oauth-client-metadata",
    JSON.stringify({ client_name: clientName, scope: oauthScope }),
  ];
}
