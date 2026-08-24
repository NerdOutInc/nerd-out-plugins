import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins/recall");

function readJSON(...segments) {
  return JSON.parse(fs.readFileSync(path.join(root, ...segments), "utf8"));
}

test("packages Cursor as a separate official host plugin", () => {
  const manifest = readJSON("plugins/recall/.cursor-plugin/plugin.json");
  const mcp = readJSON("plugins/recall/mcp.json");
  const hooks = readJSON("plugins/recall/.cursor-plugin/hooks.json");
  const marketplace = readJSON(".cursor-plugin/marketplace.json");

  assert.equal(manifest.name, "recall");
  assert.equal(manifest.displayName, "Recall");
  assert.equal(manifest.version, "0.29.0");
  assert.equal(manifest.mcpServers, "./mcp.json");
  assert.equal(manifest.hooks, "./.cursor-plugin/hooks.json");
  assert.equal(manifest.skills, "./skills/");

  const server = mcp.mcpServers.recall;
  assert.equal(server.cwd, "${CURSOR_PLUGIN_ROOT}");
  assert.deepEqual(server.args.slice(-2), ["--client-name", "Cursor"]);
  assert.equal(JSON.stringify(server).includes("CLAUDE_PLUGIN_ROOT"), false);

  const sessionStart = hooks.hooks.sessionStart;
  assert.equal(hooks.version, 1);
  assert.equal(sessionStart.length, 1);
  assert.match(
    sessionStart[0].command,
    /\$\{CURSOR_PLUGIN_ROOT\}.*--host cursor$/,
  );
  assert.equal(sessionStart[0].command.includes("${PLUGIN_ROOT}"), false);
  assert.equal(hooks.hooks.beforeSubmitPrompt, undefined);
  assert.equal(hooks.hooks.UserPromptSubmit, undefined);

  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].source, "plugins/recall");
  assert.equal(fs.existsSync(path.join(pluginRoot, "skills/recall-journal/SKILL.md")), true);
});

test("keeps host manifests on one release version", () => {
  const versions = ["claude", "codex", "cursor"].map((host) => {
    const directory = host === "claude" ? ".claude-plugin" : `.${host}-plugin`;
    return readJSON(`plugins/recall/${directory}/plugin.json`).version;
  });

  assert.deepEqual(versions, ["0.29.0", "0.29.0", "0.29.0"]);
});
