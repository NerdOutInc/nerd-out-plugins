import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CLIENT_NAME,
  clientCacheDirectory,
  parseClientName,
  proxyArgs,
} from "../plugins/recall-notes/bridge/client-identity.mjs";

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
    path.join(baseDirectory, "recall-notes", "codex")
  );
  assert.equal(
    clientCacheDirectory("Claude Desktop", baseDirectory),
    path.join(baseDirectory, "recall-notes", "claude-desktop")
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
      "plugins/recall-notes/bridge/mcp-remote-proxy.bundle.mjs",
      repoRoot
    ),
    "utf8"
  );

  assert.match(bundle, /--static-oauth-client-metadata/);
  assert.match(bundle, /MCP_REMOTE_CONFIG_DIR/);
});

test("host manifests supply useful OAuth client names", async () => {
  const [codex, claude, desktop] = await Promise.all([
    readJson("plugins/recall-notes/.codex-plugin/mcp.json"),
    readJson("plugins/recall-notes/.mcp.json"),
    readJson("desktop-extensions/recall-notes/manifest.json"),
  ]);

  assert.deepEqual(codex.mcpServers["recall-notes"].args.slice(-2), [
    "--client-name",
    "Codex",
  ]);
  assert.deepEqual(claude.mcpServers["recall-notes"].args.slice(-2), [
    "--client-name",
    "Claude",
  ]);
  assert.deepEqual(desktop.server.mcp_config.args.slice(-2), [
    "--client-name",
    "Claude Desktop",
  ]);
});

test("marketplace and package manifests use Recall identities", async () => {
  const [
    codexMarketplace,
    claudeMarketplace,
    codexPlugin,
    claudePlugin,
    desktop,
    rootReadme,
  ] = await Promise.all([
    readJson(".agents/plugins/marketplace.json"),
    readJson(".claude-plugin/marketplace.json"),
    readJson("plugins/recall-notes/.codex-plugin/plugin.json"),
    readJson("plugins/recall-notes/.claude-plugin/plugin.json"),
    readJson("desktop-extensions/recall-notes/manifest.json"),
    readFile(new URL("README.md", repoRoot), "utf8"),
  ]);

  assert.equal(codexMarketplace.name, "recall");
  assert.equal(codexMarketplace.plugins[0].name, "recall-notes");
  assert.equal(
    codexMarketplace.plugins[0].source.path,
    "./plugins/recall-notes"
  );
  assert.equal(claudeMarketplace.name, "recall");
  assert.equal(claudeMarketplace.plugins[0].name, "recall-notes");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/recall-notes");
  assert.equal(
    claudeMarketplace.description,
    "Plugin for the Recall notes app."
  );
  assert.equal(codexPlugin.name, "recall-notes");
  assert.equal(codexPlugin.interface.displayName, "Recall");
  assert.equal(claudePlugin.name, "recall-notes");
  assert.equal(desktop.name, "recall-notes");
  assert.equal(desktop.display_name, "Recall");
  assert.match(rootReadme, /AI plugins for the Recall notes app\./);
  assert.doesNotMatch(rootReadme, new RegExp(["Recall", "Notes"].join(" ")));

  for (const repositoryUrl of [
    codexPlugin.repository,
    claudePlugin.repository,
    desktop.support,
  ]) {
    assert.match(repositoryUrl, /NerdOutInc\/recall-plugins/);
    assert.doesNotMatch(repositoryUrl, /nerd-out-plugins/);
  }
});

test("the plugin and desktop-extension bridge copies stay byte-identical", async () => {
  const [pluginIndex, desktopIndex, pluginIdentity, desktopIdentity] =
    await Promise.all([
      readFile(
        new URL("plugins/recall-notes/bridge/index.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/recall-notes/server/index.mjs",
          repoRoot
        ),
        "utf8"
      ),
      readFile(
        new URL("plugins/recall-notes/bridge/client-identity.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/recall-notes/server/client-identity.mjs",
          repoRoot
        ),
        "utf8"
      ),
    ]);

  assert.equal(desktopIndex, pluginIndex);
  assert.equal(desktopIdentity, pluginIdentity);
});
