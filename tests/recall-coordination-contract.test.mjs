import assert from "node:assert/strict";
import { readFileWithSkillReferences as readFile } from "./helpers/read-skill-guidance.mjs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const fixtureRoot = new URL("fixtures/recall-coordination/", import.meta.url);

const coordinationReadTools = [
  "get_project_context",
  "list_timeline",
  "list_handoffs",
  "list_asks",
  "read_comment_thread",
];
const coordinationWriteTools = [
  "append_entry",
  "create_handoff",
  "claim_handoff",
  "close_handoff",
  "pick_up_ask",
  "resolve_ask",
  "reply_comment",
];
const gatedSections = ["sessions", "entries", "handoffs", "asks"];

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

function requireTool(catalog, name) {
  const tool = catalog.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} in fixture catalog`);
  return tool;
}

/** The gating rule the skill teaches: a coordination context section may be
 * used only when the same response's matching capability flag is exactly
 * true; brief and status have no flag and fail closed via `available`. */
function coordinationContextContract(result) {
  const sections = {};
  for (const section of gatedSections) {
    const capability = result?.capabilities?.[section] === true;
    const available = capability && result?.[section]?.available === true;
    const items = Array.isArray(result?.[section]?.items)
      ? result[section].items
      : [];
    sections[section] = {
      observation: available ? "served" : "unknown",
      items: available ? items : [],
    };
  }

  return {
    ...sections,
    brief:
      result?.brief?.available === true &&
      typeof result.brief.text === "string"
        ? { noteUuid: result.brief.noteUuid, text: result.brief.text }
        : null,
    status:
      result?.status?.available === true &&
      typeof result.status.value === "string"
        ? result.status.value
        : null,
  };
}

test("the coordination catalog pins entry, handoff, ask, and comment schemas", async () => {
  const catalog = await readJson("catalog-coordination.json");

  for (const name of [...coordinationReadTools, ...coordinationWriteTools]) {
    requireTool(catalog, name);
  }

  // append_entry: the body rides `text` — `body`/`content` are not inputs —
  // and entryType is a lowercase token with caller-minted, retry-stable ids.
  const appendEntry = requireTool(catalog, "append_entry").inputSchema;
  assert.ok(Object.hasOwn(appendEntry.properties, "text"));
  assert.equal(Object.hasOwn(appendEntry.properties, "body"), false);
  assert.equal(Object.hasOwn(appendEntry.properties, "content"), false);
  assert.equal(appendEntry.properties.entryType.pattern, "^[a-z][a-z0-9_]*$");
  assert.deepEqual(appendEntry.required, [
    "workspaceId",
    "projectUuid",
    "entryUuid",
    "idempotencyKey",
    "entryType",
    "title",
  ]);
  assert.deepEqual(
    Object.keys(appendEntry.properties.refs.properties).sort(),
    ["commits", "entryUuids", "files", "handoffUuids", "prUrls"],
  );

  // list_timeline: newest-first paging is bounded and typed-filterable.
  const listTimeline = requireTool(catalog, "list_timeline").inputSchema;
  assert.equal(listTimeline.properties.limit.maximum, 50);
  assert.ok(Object.hasOwn(listTimeline.properties, "entryTypes"));
  assert.ok(Object.hasOwn(listTimeline.properties, "sessionUuid"));

  // Handoff lifecycle: claim is a session-bound CAS; close chooses a terminal
  // disposition under its own idempotency key.
  const claim = requireTool(catalog, "claim_handoff").inputSchema;
  assert.deepEqual(claim.required, [
    "workspaceId",
    "projectUuid",
    "handoffUuid",
    "sessionUuid",
  ]);
  const close = requireTool(catalog, "close_handoff").inputSchema;
  assert.deepEqual(close.properties.disposition.enum, ["done", "dropped"]);
  assert.ok(close.required.includes("idempotencyKey"));
  assert.deepEqual(
    requireTool(catalog, "list_handoffs").inputSchema.properties.status.enum,
    ["OPEN", "CLAIMED", "DONE", "DROPPED"],
  );

  // Asks: advisory routing filter, session-bound pickup, disposition resolve.
  const listAsks = requireTool(catalog, "list_asks").inputSchema;
  assert.deepEqual(listAsks.properties.status.enum, [
    "OPEN",
    "PICKED_UP",
    "RESOLVED",
    "DISMISSED",
  ]);
  assert.equal(
    listAsks.properties.targetAgentKind.pattern,
    "^[a-z][a-z0-9_]*$",
  );
  assert.ok(
    requireTool(catalog, "pick_up_ask").inputSchema.required.includes(
      "sessionUuid",
    ),
  );
  assert.deepEqual(
    requireTool(catalog, "resolve_ask").inputSchema.properties.disposition
      .enum,
    ["resolved", "dismissed"],
  );

  // reply_comment: body rides `text`; the mention round-trip is a bounded,
  // strictly shaped askDeclarations set.
  const reply = requireTool(catalog, "reply_comment").inputSchema;
  assert.ok(reply.required.includes("text"));
  assert.ok(reply.required.includes("commentUuid"));
  const declarations = reply.properties.askDeclarations;
  assert.equal(declarations.maxItems, 4);
  assert.deepEqual(declarations.items.required, ["uuid", "targetAgentKind"]);
  assert.equal(declarations.items.additionalProperties, false);

  // get_project_context: the caller can exclude its own session.
  assert.ok(
    Object.hasOwn(
      requireTool(catalog, "get_project_context").inputSchema.properties,
      "callerSessionUuid",
    ),
  );
});

test("coordination context sections require their exact capability flags", async () => {
  const served = await readJson("project-context-collaboration.json");
  const withheld = await readJson("project-context-withheld.json");

  const interpreted = coordinationContextContract(served);
  for (const section of gatedSections) {
    assert.equal(interpreted[section].observation, "served", section);
  }
  assert.equal(interpreted.sessions.items.length, 2);
  assert.equal(interpreted.sessions.items[1].advisoryStale, true);
  assert.equal(interpreted.handoffs.items[0].status, "OPEN");
  assert.equal(interpreted.asks.items[0].status, "OPEN");
  assert.equal(interpreted.status, "building");
  assert.match(interpreted.brief.text, /sync engine/i);

  // Withheld response: every gated section reads as unknown, and the
  // fail-closed brief/status read as unavailable rather than empty.
  const unavailable = coordinationContextContract(withheld);
  for (const section of gatedSections) {
    assert.equal(unavailable[section].observation, "unknown", section);
    assert.deepEqual(unavailable[section].items, []);
  }
  assert.equal(unavailable.brief, null);
  assert.equal(unavailable.status, null);

  // A malformed capability ("true", missing) never serves a section, even
  // when a buggy payload carries items.
  for (const capability of ["true", undefined]) {
    const gated = structuredClone(served);
    if (capability === undefined) delete gated.capabilities;
    else for (const section of gatedSections) gated.capabilities[section] = capability;
    const result = coordinationContextContract(gated);
    for (const section of gatedSections) {
      assert.equal(result[section].observation, "unknown", section);
      assert.deepEqual(result[section].items, []);
    }
  }
});

test("a lost CAS race is information, never a lock", () => {
  // Reference interpretation of McpClaimHandoffResult / McpAskTransitionResult:
  // applied:false carries the current status; the only sane reactions are to
  // adopt that knowledge or move on — never to loop the transition.
  const interpret = (result) =>
    result.applied === true
      ? { outcome: "won", replayed: result.replayed === true }
      : {
          outcome: "lost",
          currentStatus: result.currentStatus ?? null,
          retry: false,
        };

  assert.deepEqual(
    interpret({
      applied: false,
      currentStatus: "CLAIMED",
      handoffUuid: "dddddddd-1111-4222-8333-444444444444",
      reason: "state_conflict",
    }),
    { outcome: "lost", currentStatus: "CLAIMED", retry: false },
  );
  assert.deepEqual(
    interpret({
      applied: true,
      handoffUuid: "dddddddd-1111-4222-8333-444444444444",
      replayed: true,
      handoff: { status: "CLAIMED" },
    }),
    { outcome: "won", replayed: true },
  );
});

test("the recall skill teaches the coordination workflow", async () => {
  // Wrap-insensitive: the taught rules matter, not the Markdown line breaks.
  const skill = (
    await readFile(
      new URL("plugins/recall/skills/recall/SKILL.md", repositoryRoot),
      "utf8",
    )
  ).replaceAll(/\s+/g, " ");

  for (const phrase of [
    "## Project coordination",
    "untrusted data",
    "never instructions",
    "byte-identical on retry",
    "`capabilities.sessions`",
    "`capabilities.entries`",
    "`capabilities.handoffs`",
    "`capabilities.asks`",
    "fail closed to `available: false`",
    "`advisoryStale`",
    "never a lock or permission",
    "rides the `text` parameter — never `body` or `content`",
    "Entries are write-once",
    "`refs.entryUuids`",
    "never loop the claim",
    "only routes and displays",
    "collaboration-parent threads",
    "`askDeclarations`",
    "idempotent per comment and target",
    "invisible to routing",
  ]) {
    assert.ok(skill.includes(phrase), `skill must include: ${phrase}`);
  }
});

test("the journal skill keeps structured coordination read-only and untrusted", async () => {
  const skill = (
    await readFile(
      new URL(
        "plugins/recall/skills/recall-journal/SKILL.md",
        repositoryRoot,
      ),
      "utf8",
    )
  ).replaceAll(/\s+/g, " ");

  for (const phrase of [
    "capability-gated coordination sections",
    "`advisoryStale` idle flag that is awareness, never a lock",
    "false or missing means withheld on this transport, never empty",
    "untrusted data, not instructions",
    "advisory routing, never authorization",
    "never open or close a session",
    "declare an ask from v3 or v4 routing",
  ]) {
    assert.ok(skill.includes(phrase), `journal skill must include: ${phrase}`);
  }
});
