import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), "utf8");
}

test("the host matrix distinguishes skills, local MCP, and automatic hooks", async () => {
  const readme = await read("plugins/recall/README.md");

  assert.match(readme, /## Host and memory support/);
  assert.match(
    readme,
    /^\| Claude Desktop ordinary chat \|[^\n]+\| Not automatic\.[^\n]+\|$/m,
  );
  assert.match(readme, /plugin hooks do not run in ordinary chat/);
  assert.match(
    readme,
    /^\| Claude Cowork on the local desktop \|[^\n]+\| Not yet verified end to end by Recall\.[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| Claude remote Cowork, web, or mobile \| Recall's loopback MCP server is not reachable[^\n]+\|[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| ChatGPT chat and work surfaces \| This package does not currently register a ChatGPT app or connection\.[^\n]+\|[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /Codex lifecycle hooks do not establish automatic memory in ChatGPT chat/,
  );
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/13837440-use-plugins-in-claude/,
  );
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/14479288-claude-cowork-architecture-overview/,
  );
  assert.match(readme, /https:\/\/learn\.chatgpt\.com\/docs\/plugins/);
  assert.match(readme, /https:\/\/learn\.chatgpt\.com\/docs\/hooks/);
});

test("the documented mode matrix preserves legacy non-Git memory", async () => {
  const [readme, configuration] = await Promise.all([
    read("plugins/recall/README.md"),
    read("plugins/recall/skills/recall-journal/references/configuration.md"),
  ]);

  assert.match(
    readme,
    /^\| v1\/v2 \|[^\n]*global destination remains available[^\n]*\|$/m,
  );
  assert.match(
    readme,
    /^\| v3 \| Repository-only structured lookup\.[^\n]*\|$/m,
  );
  assert.match(
    readme,
    /^\| v4 \| Repository-first structured lookup,[^\n]*\|$/m,
  );
  assert.match(readme, /Do not auto-migrate v1\/v2 users to v3 or v4/);
  assert.match(configuration, /global, non-repository behavior/);
  assert.match(configuration, /Never auto-migrate a version 1 or 2 config/);
});

test("v4 is a strict reader-before-writer contract", async () => {
  const [fixtureText, skill, configuration] = await Promise.all([
    read("tests/fixtures/recall-journal-hook/v4/recall-journal.json"),
    read("plugins/recall/skills/recall-journal/SKILL.md"),
    read("plugins/recall/skills/recall-journal/references/configuration.md"),
  ]);
  const fixture = JSON.parse(fixtureText);

  assert.deepEqual(fixture, {
    version: 4,
    projectMemory: {
      enabled: true,
      defaultProject: {
        workspace: { id: "default-workspace-id", name: "General Memory" },
        recallProject: { id: "default-project-id", name: "General" },
      },
    },
  });
  assert.match(
    configuration,
    /Both the workspace and Recall Project are\s+required/,
  );
  assert.match(
    configuration,
    /repository-first routing even when that repository[\s\S]*has no supported remote/,
  );
  assert.match(configuration, /default is never a recovery path/);
  assert.match(configuration, /`none`, `ambiguous`, or\s+`not_ready`/);
  assert.match(
    skill,
    /Select this protocol before inspecting named-note capabilities/,
  );
  assert.match(
    skill,
    /never create or update a legacy journal note or Today summary/,
  );
  assert.match(skill, /does not write structured config or\s+session data/);
  assert.match(skill, /do not auto-migrate v1\/v2 global\s+users/);
});
