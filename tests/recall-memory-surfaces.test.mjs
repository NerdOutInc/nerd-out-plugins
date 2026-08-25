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
  assert.match(readme, /authenticate the\s+outermost signed host/);
  assert.match(readme, /label cannot grant access or control attribution/);
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
  assert.match(
    readme,
    /^\| v5 \| Repository-first exact Project lookup[^\n]*Today -> Now activity[^\n]*\|$/m,
  );
  assert.match(readme, /Do not auto-migrate v1\/v2 users to a structured mode/);
  assert.match(
    readme,
    /Structured sessions and checkpoints are user-facing in \*\*Today -> Now\s+activity\*\*, while app-owned day summaries land as Today timeline cards/,
  );
  assert.doesNotMatch(
    readme,
    /sessions, checkpoints, and app-owned summaries are user-facing in/,
  );
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
  // Version 5 writes structured sessions. What must survive is the narrower
  // contract: v3/v4 stay readers and can upgrade only through an explicit,
  // confirmed whole-mode conversion.
  assert.match(
    skill,
    /create a\s+structured session under version 3 or version 4/,
  );
  assert.match(
    skill,
    /explicit, confirmed whole-mode upgrade may replace\s+v3 or v4 with v5/,
  );
  assert.match(skill, /do not\s+auto-migrate v1\/v2 global users/);
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
  assert.match(skill, /Today -> Now activity/);
  assert.match(skill, /concise plain-language `intent`/);
  assert.match(skill, /human-readable `title`/);
  assert.match(
    skill,
    /Always point the entry at this ACTIVE\s+session with `sessionUuid`/,
  );
  assert.match(
    skill,
    /A normal task should produce only a handful of checkpoints/,
  );
  assert.match(skill, /rejoin the shared chronology after close/);

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
    "updated",
    "already_exists",
    "deferred",
    "failed",
  ]) {
    assert.match(skill, new RegExp(`\`${status}\``), status);
  }

  // The card's Related Notes section belongs to the app, never the agent.
  assert.match(skill, /Related Notes/);
  assert.match(skill, /Never hand-write a Related Notes section/);
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

test("v5 setup and migration are explicit, exact, and capability-gated", async () => {
  const [skill, configuration] = await Promise.all([
    read("plugins/recall/skills/recall-journal/SKILL.md"),
    read("plugins/recall/skills/recall-journal/references/configuration.md"),
  ]);

  for (const tool of [
    "resolve_project",
    "get_project_context",
    "open_session",
    "append_entry",
    "close_session",
  ]) {
    assert.match(configuration, new RegExp(`\`${tool}\``), tool);
  }
  for (const field of [
    "lineageKey",
    "sessionUuid",
    "entryType",
    "daySummary",
  ]) {
    assert.match(configuration, new RegExp(`\`${field}\``), field);
  }

  assert.match(configuration, /If any part is absent, do not write version 5/);
  assert.match(
    configuration,
    /If a v5 config already exists,\s+leave it unchanged/,
  );
  assert.match(configuration, /workspace root is invalid/);
  assert.match(configuration, /cannot be translated\s+losslessly/);
  assert.match(
    configuration,
    /Version 5 has no persistent `summaryTarget: "none"` preference/,
  );
  assert.match(configuration, /show the exact replacement v5 shape/);
  assert.match(configuration, /When disabling version 5/);
  assert.match(
    configuration,
    /Older journal notes and Today cards remain untouched/,
  );
  assert.match(skill, /Lifecycle context never\s+changes a config version/);
});

test("user-facing note activity gets a useful change summary", async () => {
  const [recallSkill, journalSkill] = await Promise.all([
    read("plugins/recall/skills/recall/SKILL.md"),
    read("plugins/recall/skills/recall-journal/SKILL.md"),
  ]);

  for (const skill of [recallSkill, journalSkill]) {
    assert.match(
      skill,
      /Recall (?:can|may) show (?:it|the summary) in\s+Today -> Now activity and\s+the note's History/,
    );
    assert.match(
      skill,
      /expectedRevision`, `idempotencyKey`, and\s+`changeSummary`/,
    );
    assert.match(skill, /partial bundle is rejected/);
    assert.match(skill, /caller-minted UUID/);
    assert.match(
      skill,
      /omit both `(?:changeSummary|idempotencyKey)` and `(?:idempotencyKey|changeSummary)`/,
    );
    assert.match(skill, /never (?:put|use) (?:paths?|a path),? hash(?:es)?/i);
  }
});
