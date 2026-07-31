import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DEFAULT_CLIENT_NAME,
  clientCacheDirectory,
  parseClientName,
  proxyArgs,
} from "../plugins/recall/bridge/client-identity.mjs";

const repoRoot = new URL("../", import.meta.url);
const execFileAsync = promisify(execFile);

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
    path.join(baseDirectory, "recall", "codex")
  );
  assert.equal(
    clientCacheDirectory("Claude Desktop", baseDirectory),
    path.join(baseDirectory, "recall", "claude-desktop")
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
      "plugins/recall/bridge/mcp-remote-proxy.bundle.mjs",
      repoRoot
    ),
    "utf8"
  );

  assert.match(bundle, /--static-oauth-client-metadata/);
  assert.match(bundle, /MCP_REMOTE_CONFIG_DIR/);
});

test("host manifests supply useful OAuth client names", async () => {
  const [codex, claude, desktop] = await Promise.all([
    readJson("plugins/recall/.codex-plugin/mcp.json"),
    readJson("plugins/recall/.mcp.json"),
    readJson("desktop-extensions/recall/manifest.json"),
  ]);

  assert.deepEqual(codex.mcpServers["recall"].args.slice(-2), [
    "--client-name",
    "Codex",
  ]);
  assert.deepEqual(claude.mcpServers["recall"].args.slice(-2), [
    "--client-name",
    "Claude",
  ]);
  assert.deepEqual(desktop.server.mcp_config.args.slice(-2), [
    "--client-name",
    "Claude Desktop",
  ]);
});

test("plugin manifests prefer Recall's pinned Node runtime", async () => {
  const [codex, claude, hooks, launcher] = await Promise.all([
    readJson("plugins/recall/.codex-plugin/mcp.json"),
    readJson("plugins/recall/.mcp.json"),
    readJson("plugins/recall/hooks/hooks.json"),
    readFile(new URL("plugins/recall/bridge/recall-node", repoRoot), "utf8"),
  ]);

  assert.equal(codex.mcpServers.recall.command, "/bin/sh");
  assert.equal(codex.mcpServers.recall.args[0], "./bridge/recall-node");
  assert.equal(claude.mcpServers.recall.command, "/bin/sh");
  assert.equal(
    claude.mcpServers.recall.args[0],
    "${CLAUDE_PLUGIN_ROOT}/bridge/recall-node"
  );
  assert.match(
    hooks.hooks.UserPromptSubmit[0].hooks[0].command,
    /bridge\/recall-node/
  );
  assert.match(
    launcher,
    /Library\/Application Support\/Recall\/AgentRuntime\/bin\/recall-node/
  );
  assert.match(launcher, /command -v node/);
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
    readJson("plugins/recall/.codex-plugin/plugin.json"),
    readJson("plugins/recall/.claude-plugin/plugin.json"),
    readJson("desktop-extensions/recall/manifest.json"),
    readFile(new URL("README.md", repoRoot), "utf8"),
  ]);

  assert.equal(codexMarketplace.name, "recall");
  assert.equal(codexMarketplace.plugins[0].name, "recall");
  assert.equal(
    codexMarketplace.plugins[0].source.path,
    "./plugins/recall"
  );
  assert.equal(claudeMarketplace.name, "recall");
  assert.equal(claudeMarketplace.plugins[0].name, "recall");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/recall");
  assert.equal(
    claudeMarketplace.description,
    "Plugin for the Recall notes app."
  );
  assert.equal(codexPlugin.name, "recall");
  assert.equal(codexPlugin.interface.displayName, "Recall");
  assert.equal(claudePlugin.name, "recall");
  assert.equal(desktop.name, "recall");
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

test("tracked paths and content use only the recall plugin identifier", async () => {
  const formerIdentifier = ["recall", "notes"].join("-");
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const trackedPaths = stdout.split("\0").filter(Boolean);

  for (const trackedPath of trackedPaths) {
    assert.doesNotMatch(trackedPath, new RegExp(formerIdentifier));
    const content = await readFile(new URL(trackedPath, repoRoot));
    assert.equal(
      content.includes(formerIdentifier),
      false,
      `${trackedPath} contains the former plugin identifier`,
    );
  }
});

test("the plugin and desktop-extension bridge copies stay byte-identical", async () => {
  const [pluginIndex, desktopIndex, pluginIdentity, desktopIdentity] =
    await Promise.all([
      readFile(
        new URL("plugins/recall/bridge/index.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/recall/server/index.mjs",
          repoRoot
        ),
        "utf8"
      ),
      readFile(
        new URL("plugins/recall/bridge/client-identity.mjs", repoRoot),
        "utf8"
      ),
      readFile(
        new URL(
          "desktop-extensions/recall/server/client-identity.mjs",
          repoRoot
        ),
        "utf8"
      ),
    ]);

  assert.equal(desktopIndex, pluginIndex);
  assert.equal(desktopIdentity, pluginIdentity);
});
