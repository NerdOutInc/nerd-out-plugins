import os from "node:os";
import path from "node:path";

export const DEFAULT_CLIENT_NAME = "Recall MCP Client";
const CLIENT_NAME_FLAG = "--client-name";
const MAX_CLIENT_NAME_LENGTH = 100;

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

export function proxyArgs(bundlePath, serverUrl, clientName) {
  return [
    bundlePath,
    serverUrl,
    "--transport",
    "http-only",
    "--static-oauth-client-metadata",
    JSON.stringify({ client_name: clientName }),
  ];
}
