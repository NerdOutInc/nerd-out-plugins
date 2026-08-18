import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), "utf8");
}

test("the host matrix distinguishes skills, local MCP, and automatic hooks", async () => {
  const [readme, mcpText, hooksText] = await Promise.all([
    read("plugins/recall/README.md"),
    read("plugins/recall/.mcp.json"),
    read("plugins/recall/hooks/hooks.json"),
  ]);
  const mcp = JSON.parse(mcpText);
  const hooks = JSON.parse(hooksText);
  const server = mcp.mcpServers.recall;

  assert.match(readme, /## Host and memory support/);
  assert.match(
    readme,
    /^\| Claude Desktop Chat \|[^\n]+not been re-certified live[^\n]+\| Not automatic\.[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| Claude web Chat \|[^\n]+cannot directly launch this local stdio server[^\n]+\| Not automatic\.[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| Cowork local execution on Claude Desktop \|[^\n]+not yet live-certified[^\n]+\| Not yet Recall-certified\.[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| Cowork cloud session with Claude Desktop open and online \|[^\n]+cloud sandbox never connects to `127\.0\.0\.1` directly[^\n]+\| Not yet Recall-certified\.[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| Cowork cloud session with Claude Desktop closed or offline \| Recall tools are unavailable\.[^\n]+\| Tool-backed Recall memory is unavailable[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /^\| ChatGPT chat and work surfaces \| This package does not currently register a ChatGPT app or connection\.[^\n]+\|[^\n]+\|$/m,
  );
  assert.match(
    readme,
    /Codex lifecycle hooks do not establish automatic memory in ChatGPT chat/,
  );
  assert.match(readme, /hooks run in Cowork rather than ordinary Chat/);
  assert.match(readme, /no direct cloud loopback path to Recall/);
  assert.match(readme, /legacy standalone Recall desktop extension/);
  assert.match(readme, /advisory, self-reported label/);
  assert.doesNotMatch(readme, /remote Cowork cannot reach a local MCP server/);
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/13837440-use-plugins-in-claude/,
  );
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/14479288-claude-cowork-architecture-overview/,
  );
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/15520349-use-claude-cowork-on-web-desktop-and-mobile/,
  );
  assert.match(
    readme,
    /https:\/\/support\.claude\.com\/en\/articles\/11175166-get-started-with-custom-connectors-using-remote-mcp/,
  );
  assert.match(readme, /https:\/\/learn\.chatgpt\.com\/docs\/plugins/);
  assert.match(readme, /https:\/\/learn\.chatgpt\.com\/docs\/hooks/);

  assert.equal(server.type, "stdio");
  assert.equal(Object.hasOwn(server, "url"), false);
  assert.deepEqual(server.args.slice(-2), ["--client-name", "Claude"]);
  assert.equal(
    server.args.some((argument) => /Cowork/i.test(argument)),
    false,
  );
  assert.deepEqual(Object.keys(hooks.hooks), ["UserPromptSubmit"]);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].type, "command");
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
  // Version 5 writes structured sessions, so the old blanket "writes nothing
  // structured" sentence is gone. What must survive is the narrower contract:
  // v3/v4 stay readers, and no config version is ever written but v1/v2.
  assert.match(
    skill,
    /create a\s+structured session under version 3 or version 4/,
  );
  assert.match(
    skill,
    /never writes, migrates, or downgrades a version 3,\s+version 4, or version 5 config/,
  );
  assert.match(skill, /do not auto-migrate v1\/v2 global\s+users/);
});

test("v5 teaches the session tools and retires the hand-executed mechanics", async () => {
  const skill = await read("plugins/recall/skills/recall-journal/SKILL.md");

  // The structured protocol must name the whole write path.
  assert.match(skill, /## Structured journaling \(version 5\)/);
  assert.match(skill, /`open_session`/);
  assert.match(skill, /`append_entry`/);
  assert.match(skill, /`close_session`/);
  assert.match(skill, /`daySummary`/);
  assert.match(skill, /`previousSession`/);

  // Continuity honesty: absence must never read as proof of no predecessor.
  assert.match(skill, /`sessionContinuityAvailable`/);
  assert.match(skill, /absence means unknown/);

  // Awareness is advisory, never a lock.
  assert.match(skill, /never a lock/);

  // The app owns the card's mechanics now.
  assert.match(
    skill,
    /Do not compute an\s+idempotency key, do not emit a heading, and do not attach a backlink/,
  );

  // Every close-result state must be explained, including the two that are
  // easy to misreport as success or as failure.
  for (const status of [
    "created",
    "already_exists",
    "deferred",
    "failed",
  ]) {
    assert.match(skill, new RegExp(`\`${status}\``), status);
  }
});

test("v5 forbids a hybrid and keeps the legacy protocol as the whole fallback", async () => {
  const skill = await read("plugins/recall/skills/recall-journal/SKILL.md");

  // The fallback is all-or-nothing: a partial structured surface must not
  // produce structured sessions plus a hand-built card.
  assert.match(skill, /Structured journaling needs \*\*all\*\* of/);
  assert.match(skill, /Fall back to the \*\*entire\*\* legacy protocol/);
  assert.match(skill, /Never mix the two/);

  // Degradation is always explicit to the user.
  assert.match(
    skill,
    /say plainly in the\s+final response that structured journaling was unavailable/,
  );

  // The legacy sections must remain present and explicitly scoped, because
  // v1/v2 users and the fallback both still execute them.
  assert.match(skill, /The rest of this document is the legacy note protocol/);
  assert.match(skill, /### Thread identity and journal markers/);
  assert.match(skill, /### Write-failure protocol/);
});

test("v5 never invents continuity or rewrites the archive", async () => {
  const skill = await read("plugins/recall/skills/recall-journal/SKILL.md");

  assert.match(skill, /Never invent a lineage key when the host supplies no/);
  assert.match(skill, /Never rewrite history/);
  assert.match(
    skill,
    /Older journal notes stay readable archive[\s\S]*never migrated or rewritten/,
  );
});
