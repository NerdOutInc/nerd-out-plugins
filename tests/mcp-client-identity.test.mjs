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
  oauthScopeForSupportedScopes,
  RECALL_LEGACY_OAUTH_SCOPE,
  RECALL_PROJECT_CONTEXT_OAUTH_SCOPE,
  RECALL_LOOPBACK_HOST,
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

test("OAuth scope discovery widens only from explicit compatible metadata", () => {
  assert.equal(
    oauthScopeForSupportedScopes(undefined),
    RECALL_LEGACY_OAUTH_SCOPE
  );
  assert.equal(oauthScopeForSupportedScopes({}), RECALL_LEGACY_OAUTH_SCOPE);
  assert.equal(
    oauthScopeForSupportedScopes(["notes:read", "notes:write"]),
    RECALL_LEGACY_OAUTH_SCOPE
  );
  assert.equal(
    oauthScopeForSupportedScopes([
      "journal:write",
      "notes:write",
      "journal:read",
      "notes:read",
      "unknown:scope",
    ]),
    RECALL_PROJECT_CONTEXT_OAUTH_SCOPE
  );
  assert.equal(
    oauthScopeForSupportedScopes([
      "notes:read",
      "notes:write",
      "journal:read",
    ]),
    RECALL_PROJECT_CONTEXT_OAUTH_SCOPE
  );
  assert.equal(
    oauthScopeForSupportedScopes([
      "notes:read",
      "notes:write",
      "journal:write",
    ]),
    RECALL_LEGACY_OAUTH_SCOPE
  );
  assert.equal(
    oauthScopeForSupportedScopes([
      "notes:read",
      "journal:read",
      "journal:write",
    ]),
    RECALL_LEGACY_OAUTH_SCOPE
  );
});

test("the proxy accepts the scope selected for the installed Recall resource", () => {
  const args = proxyArgs(
    "/tmp/proxy.mjs",
    "http://127.0.0.1:38473/mcp",
    "Codex",
    RECALL_PROJECT_CONTEXT_OAUTH_SCOPE
  );
  const metadataFlagIndex = args.indexOf("--static-oauth-client-metadata");

  assert.deepEqual(JSON.parse(args[metadataFlagIndex + 1]), {
    client_name: "Codex",
    scope: RECALL_PROJECT_CONTEXT_OAUTH_SCOPE,
  });
});

test("the proxy and the coordinator present the same loopback host form", async () => {
  const args = proxyArgs(
    "/tmp/proxy.mjs",
    "http://127.0.0.1:38473/mcp",
    "Claude"
  );
  const hostFlagIndex = args.indexOf("--host");

  // Without an explicit --host, mcp-remote registers `localhost` redirect
  // URIs while the coordinator registers 127.0.0.1 ones; whichever flow runs
  // second then presents a redirect_uri the authorization server never saw
  // (the 2026-08-12 re-authorization failure against recall.nerdout.com).
  assert.notEqual(hostFlagIndex, -1);
  assert.equal(args[hostFlagIndex + 1], RECALL_LOOPBACK_HOST);
  assert.equal(RECALL_LOOPBACK_HOST, "127.0.0.1");

  const coordinatorSource = await readFile(
    new URL(
      "plugins/recall/bridge/build/src/oauth-coordinator.ts",
      repoRoot
    ),
    "utf8"
  );
  assert.match(coordinatorSource, /host: RECALL_LOOPBACK_HOST/);
  assert.doesNotMatch(coordinatorSource, /host: "127\.0\.0\.1"/);
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
  assert.equal(claude.mcpServers.recall.type, "stdio");
  assert.equal(Object.hasOwn(claude.mcpServers.recall, "url"), false);
  assert.equal(/cowork/i.test(JSON.stringify(claude.mcpServers.recall)), false);
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

test("host manifests share the current plugin version", async () => {
  const [codexPlugin, claudePlugin] = await Promise.all([
    readJson("plugins/recall/.codex-plugin/plugin.json"),
    readJson("plugins/recall/.claude-plugin/plugin.json"),
  ]);

  // 0.17.0 remains the socket-bridge floor the Recall app gates first-use
  // authorization on. 0.18.0 adds the reader-first v3 project-memory hook;
  // 0.19.0 adds capability-probed activity and revision-safe note workflows.
  // 0.20.0 adds strict v4 repository-first/default-no-repository reads and the
  // explicit host-surface contract.
  // 0.21.0 negotiates additive journal read scope from the installed app while
  // preserving notes-only authorization against older Recall builds.
  // Both hosts must receive that behavior together.
  assert.equal(codexPlugin.version, "0.21.0");
  assert.equal(claudePlugin.version, codexPlugin.version);
  const desktop = await readJson("desktop-extensions/recall/manifest.json");
  assert.equal(desktop.version, "0.9.0");
});

test("Recall skills require full production note URLs in chat", async () => {
  const skillPaths = [
    "plugins/recall/skills/recall/SKILL.md",
    "plugins/recall/skills/recall-journal/SKILL.md"
  ];
  const skills = await Promise.all(
    skillPaths.map((relativePath) =>
      readFile(new URL(relativePath, repoRoot), "utf8")
    )
  );

  for (const skill of skills) {
    assert.match(skill, /chat/i);
    assert.match(skill, /https:\/\/recall\.nerdout\.com/);
    assert.match(skill, /relative \`\/notes\/\.\.\.\` path/);
  }
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
