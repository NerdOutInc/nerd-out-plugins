import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CLIENT_NAME,
  clientCacheDirectory,
  parseClientName,
  proxyArgs,
} from "../plugins/nerd-out-notes/bridge/client-identity.mjs";

const repoRoot = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repoRoot), "utf8"));
}

test("client names are validated before they reach OAuth metadata", () => {
  assert.equal(parseClientName([]), DEFAULT_CLIENT_NAME);
  assert.equal(parseClientName(["--client-name", "  Codex  "]), "Codex");
  assert.throws(
    () => parseClientName(["--client-name"]),
    /requires a non-empty value/
  );
  assert.throws(
    () => parseClientName(["--client-name", "--transport"]),
    /requires a non-empty value/
  );
  assert.throws(
    () =>
      parseClientName([
        "--client-name",
        "Claude",
        "--client-name",
        "Codex",
      ]),
    /may only be supplied once/
  );
  assert.throws(
    () => parseClientName(["--client-name", "x".repeat(101)]),
    /100 characters or fewer/
  );
});

test("each client receives distinct mcp-remote storage", () => {
  const baseDirectory = path.join(path.sep, "tmp", "mcp-auth");

  assert.equal(
    clientCacheDirectory("Codex", baseDirectory),
    path.join(baseDirectory, "nerd-out-notes", "codex")
  );
  assert.equal(
    clientCacheDirectory("Claude Desktop", baseDirectory),
    path.join(baseDirectory, "nerd-out-notes", "claude-desktop")
  );
  assert.notEqual(
    clientCacheDirectory("Codex", baseDirectory),
    clientCacheDirectory("Claude", baseDirectory)
  );
});

test("the bridge passes the supported dynamic-registration override", () => {
  const args = proxyArgs(
    "/tmp/proxy.mjs",
    "http://127.0.0.1:38473/mcp",
    "Codex"
  );
  const metadataFlagIndex = args.indexOf("--static-oauth-client-metadata");

  assert.notEqual(metadataFlagIndex, -1);
  assert.deepEqual(JSON.parse(args[metadataFlagIndex + 1]), {
    client_name: "Codex",
  });
});

test("the committed mcp-remote bundle supports the required overrides", async () => {
  const bundle = await readFile(
    new URL(
      "plugins/nerd-out-notes/bridge/mcp-remote-proxy.bundle.mjs",
      repoRoot
    ),
    "utf8"
  );

  assert.match(bundle, /--static-oauth-client-metadata/);
  assert.match(bundle, /MCP_REMOTE_CONFIG_DIR/);
});

test("host manifests supply useful OAuth client names", async () => {
  const [codex, claude, desktop] = await Promise.all([
    readJson("plugins/nerd-out-notes/.codex-plugin/mcp.json"),
    readJson("plugins/nerd-out-notes/.mcp.json"),
    readJson("desktop-extensions/nerd-out-notes/manifest.json"),
  ]);

  assert.deepEqual(codex.mcpServers["nerd-out-notes"].args.slice(-2), [
    "--client-name",
    "Codex",
  ]);
  assert.deepEqual(claude.mcpServers["nerd-out-notes"].args.slice(-2), [
    "--client-name",
    "Claude",
  ]);
  assert.deepEqual(desktop.server.mcp_config.args.slice(-2), [
    "--client-name",
    "Claude Desktop",
  ]);
});

test("the plugin and desktop-extension bridge copies stay byte-identical", async () => {
  const [pluginIndex, desktopIndex, pluginIdentity, desktopIdentity] =
    await Promise.all([
      readFile(
        new URL("plugins/nerd-out-notes/bridge/index.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/nerd-out-notes/server/index.mjs",
          repoRoot
        ),
        "utf8"
      ),
      readFile(
        new URL("plugins/nerd-out-notes/bridge/client-identity.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/nerd-out-notes/server/client-identity.mjs",
          repoRoot
        ),
        "utf8"
      ),
    ]);

  assert.equal(desktopIndex, pluginIndex);
  assert.equal(desktopIdentity, pluginIdentity);
});
