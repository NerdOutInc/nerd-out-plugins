import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access as fsAccess,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
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
    scope: "notes:read notes:write",
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

test("normal bridge entrypoints bind OAuth tokens to the same MCP resource", async () => {
  const [proxySource, clientSource] = await Promise.all(
    ["proxy.ts", "client.ts"].map((file) =>
      readFile(
        new URL(
          `plugins/recall/bridge/build/vendor/mcp-remote/src/${file}`,
          repoRoot
        ),
        "utf8"
      )
    )
  );

  assert.match(
    proxySource,
    /authorizeResource:\s*authorizeResource\s*\|\|\s*serverUrl/
  );
  assert.match(clientSource, /authorizeResource:\s*serverUrl/);
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

test("host manifests share the coordinator-capable plugin version", async () => {
  const [codexPlugin, claudePlugin] = await Promise.all([
    readJson("plugins/recall/.codex-plugin/plugin.json"),
    readJson("plugins/recall/.claude-plugin/plugin.json"),
  ]);

  assert.equal(codexPlugin.version, "0.12.2");
  assert.equal(claudePlugin.version, codexPlugin.version);
  const desktop = await readJson("desktop-extensions/recall/manifest.json");
  assert.equal(desktop.version, "0.7.1");
});

test("the versioned in-app OAuth coordinator is generated and inspect stays read-only", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "recall-coordinator-inspect-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const coordinator = new URL(
    "plugins/recall/bridge/oauth-coordinator.bundle.mjs",
    repoRoot
  );
  const manifest = await readJson(
    "plugins/recall/bridge/oauth-coordinator.json"
  );

  assert.deepEqual(manifest, {
    authorizationContractVersion: 1,
    entrypoint: "./oauth-coordinator.bundle.mjs",
    mcpRemoteVersion: "0.1.38",
    modes: ["inspect", "authorize", "verify-only"],
    supportedClients: ["Claude", "Codex"],
  });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      coordinator.pathname,
      "--mode",
      "inspect",
      "--client-name",
      "Claude",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, MCP_REMOTE_CONFIG_DIR: temporaryRoot },
    }
  );
  const records = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ mode, protocolVersion, status, type }) => ({
      mode,
      protocolVersion,
      status,
      type,
    })),
    [
      {
        mode: "inspect",
        protocolVersion: 1,
        status: "missing",
        type: "status",
      },
      {
        mode: "inspect",
        protocolVersion: 1,
        status: "missing",
        type: "result",
      },
    ]
  );
  assert.equal(stderr, "");
  await assert.rejects(
    fsAccess(path.join(temporaryRoot, "recall")),
    /ENOENT/
  );
});

test("the launcher validates private and PATH Node runtimes before use", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "recall-node-test-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  const privateBin = path.join(
    temporaryRoot,
    "Library",
    "Application Support",
    "Recall",
    "AgentRuntime",
    "bin"
  );
  const pathBin = path.join(temporaryRoot, "path-bin");
  await Promise.all([mkdir(privateBin, { recursive: true }), mkdir(pathBin, { recursive: true })]);

  const privateNode = path.join(privateBin, "recall-node");
  const pathNode = path.join(pathBin, "node");
  const launcher = new URL("plugins/recall/bridge/recall-node", repoRoot);
  const executable = (label, supported = true) => `#!/bin/sh
if [ "\${1:-}" = "-e" ]; then exit ${supported ? 0 : 1}; fi
printf '${label}:%s\\n' "$*"
`;

  await Promise.all([
    writeFile(privateNode, executable("private"), { mode: 0o755 }),
    writeFile(pathNode, executable("path"), { mode: 0o755 }),
  ]);
  await Promise.all([chmod(privateNode, 0o755), chmod(pathNode, 0o755)]);

  const environment = { ...process.env, HOME: temporaryRoot, PATH: pathBin };
  const privateResult = await execFileAsync("/bin/sh", [launcher.pathname, "bridge.mjs"], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(privateResult.stdout, "private:bridge.mjs\n");

  await writeFile(privateNode, executable("private", false), { mode: 0o755 });
  const fallbackResult = await execFileAsync("/bin/sh", [launcher.pathname, "bridge.mjs"], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(fallbackResult.stdout, "path:bridge.mjs\n");

  await writeFile(pathNode, executable("path", false), { mode: 0o755 });
  await assert.rejects(
    execFileAsync("/bin/sh", [launcher.pathname, "bridge.mjs"], {
      encoding: "utf8",
      env: environment,
    }),
    /Node\.js 18 or newer is not available/
  );
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
  const [pluginIndex, desktopIndex, pluginIdentity, desktopIdentity, pluginProxy, desktopProxy] =
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
      readFile(
        new URL("plugins/recall/bridge/mcp-remote-proxy.bundle.mjs", repoRoot)
      ),
      readFile(
        new URL(
          "desktop-extensions/recall/server/mcp-remote-proxy.bundle.mjs",
          repoRoot
        )
      ),
    ]);

  assert.equal(desktopIndex, pluginIndex);
  assert.equal(desktopIdentity, pluginIdentity);
  assert.deepEqual(desktopProxy, pluginProxy);
});
