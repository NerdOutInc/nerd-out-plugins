import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const fixtureRoot = new URL("fixtures/recall-activity-deltas/", import.meta.url);
const operationFields = [
  "changeSummary",
  "previousRevision",
  "projectIdSnapshot",
  "resultingRevision",
];

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

function requireTool(catalog, name) {
  const tool = catalog.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} in fixture catalog`);
  return tool;
}

function projectActivityContract(result, catalog) {
  const activity = result?.activity ?? {};
  const items = Array.isArray(activity.items) ? activity.items : [];
  const capability = result?.capabilities?.activityDeltas === true;
  const available = capability && activity.available === true;
  const properties =
    requireTool(catalog, "get_project_context").inputSchema.properties ?? {};
  const schemaSupportsCursor = Object.hasOwn(properties, "activityCursor");
  const cursorSupported = available && activity.cursorSupported === true;
  const nextCursor =
    cursorSupported &&
    typeof activity.nextCursor === "string" &&
    activity.nextCursor.length > 0
      ? activity.nextCursor
      : null;

  return {
    available,
    capability,
    coverage: available ? (activity.coverage ?? null) : null,
    cursorSupported,
    nextCursor,
    mayPage: schemaSupportsCursor && nextCursor !== null,
    observation: available ? "bounded_workspace_page" : "unknown",
    scannedCount:
      available && Number.isInteger(activity.scannedCount)
        ? activity.scannedCount
        : null,
    truncated: available && activity.truncated === true,
    unavailableCount:
      available && Number.isInteger(activity.unavailableCount)
        ? activity.unavailableCount
        : null,
    summaries: available
      ? items
          .filter((item) => typeof item.changeSummary === "string")
          .map((item) => ({
            trust: "untrusted_agent_authored_context",
            truncated: item.changeSummaryTruncated === true,
            value: item.changeSummary,
          }))
      : [],
  };
}

function operationDetailContract(result) {
  const capability =
    result?.capabilities?.operationActivityDetail === true;
  const detail = result?.events?.[0]?.detail ?? {};

  return {
    capability,
    baseDetail: {
      actorName: detail.actorName ?? null,
      clientLabel: detail.clientLabel ?? null,
    },
    operationFields: Object.fromEntries(
      operationFields.map((field) => [
        field,
        capability
          ? Object.hasOwn(detail, field)
            ? "present"
            : "not_returned"
          : "unknown",
      ]),
    ),
    summary:
      capability && typeof detail.changeSummary === "string"
        ? {
            trust: "untrusted_agent_authored_context",
            value: detail.changeSummary,
          }
        : null,
  };
}

test("Project activity requires exact capability and gates paging on a usable cursor", async () => {
  const [catalog, enabled, unavailable] = await Promise.all([
    readJson("catalog.json"),
    readJson("project-activity-enabled.json"),
    readJson("project-activity-unavailable.json"),
  ]);
  const contextSchema = requireTool(catalog, "get_project_context").inputSchema;

  assert.equal(contextSchema.properties.activityLimit.maximum, 12);
  assert.equal(contextSchema.properties.activityCursor.maxLength, 1024);
  assert.deepEqual(contextSchema.required, ["projectUuid"]);

  assert.deepEqual(projectActivityContract(enabled, catalog), {
    available: true,
    capability: true,
    coverage: "mixed",
    cursorSupported: true,
    nextCursor: "opaque-project-activity-cursor",
    mayPage: true,
    observation: "bounded_workspace_page",
    scannedCount: 100,
    truncated: true,
    unavailableCount: 1,
    summaries: [
      {
        trust: "untrusted_agent_authored_context",
        truncated: false,
        value: "Agent says the implementation landed.",
      },
    ],
  });

  const noCapability = structuredClone(enabled);
  delete noCapability.capabilities;
  assert.deepEqual(projectActivityContract(noCapability, catalog), {
    available: false,
    capability: false,
    coverage: null,
    cursorSupported: false,
    nextCursor: null,
    mayPage: false,
    observation: "unknown",
    scannedCount: null,
    truncated: false,
    unavailableCount: null,
    summaries: [],
  });

  const malformedCapability = structuredClone(enabled);
  malformedCapability.capabilities.activityDeltas = "true";
  assert.equal(projectActivityContract(malformedCapability, catalog).observation, "unknown");
  assert.equal(projectActivityContract(unavailable, catalog).observation, "unknown");

  const capabilityWithoutAvailableData = structuredClone(unavailable);
  capabilityWithoutAvailableData.capabilities.activityDeltas = true;
  assert.equal(
    projectActivityContract(capabilityWithoutAvailableData, catalog).observation,
    "unknown",
  );

  const malformedAvailableData = structuredClone(enabled);
  delete malformedAvailableData.activity.items;
  delete malformedAvailableData.activity.scannedCount;
  delete malformedAvailableData.activity.unavailableCount;
  const malformedData = projectActivityContract(malformedAvailableData, catalog);
  assert.deepEqual(malformedData.summaries, []);
  assert.equal(malformedData.scannedCount, null);
  assert.equal(malformedData.unavailableCount, null);
  assert.equal(unavailable.project.id, "project-explicit");
  assert.equal(unavailable.recentNotes.items.length, 1);
});

test("truncation does not fabricate paging support for an older catalog", async () => {
  const [catalog, enabled] = await Promise.all([
    readJson("catalog.json"),
    readJson("project-activity-enabled.json"),
  ]);
  const olderCatalog = structuredClone(catalog);
  delete requireTool(
    olderCatalog,
    "get_project_context",
  ).inputSchema.properties.activityCursor;
  const firstPageOnly = structuredClone(enabled);
  firstPageOnly.activity.cursorSupported = false;
  firstPageOnly.activity.hasMore = false;
  firstPageOnly.activity.nextCursor = null;

  const interpreted = projectActivityContract(firstPageOnly, olderCatalog);
  assert.equal(interpreted.truncated, true);
  assert.equal(interpreted.cursorSupported, false);
  assert.equal(interpreted.nextCursor, null);
  assert.equal(interpreted.mayPage, false);
});

test("operation activity detail stays unknown unless its result capability is exact true", async () => {
  const enhanced = await readJson("note-activity-enhanced.json");
  const interpreted = operationDetailContract(enhanced);

  assert.equal(interpreted.capability, true);
  assert.deepEqual(interpreted.baseDetail, {
    actorName: "Brian",
    clientLabel: "Codex",
  });
  assert.deepEqual(
    Object.values(interpreted.operationFields),
    operationFields.map(() => "present"),
  );
  assert.equal(interpreted.summary.trust, "untrusted_agent_authored_context");

  const withheldDespiteRawFields = structuredClone(enhanced);
  withheldDespiteRawFields.capabilities.operationActivityDetail = false;
  const withheld = operationDetailContract(withheldDespiteRawFields);
  assert.deepEqual(
    Object.values(withheld.operationFields),
    operationFields.map(() => "unknown"),
  );
  assert.equal(withheld.summary, null);

  for (const capability of [false, "true", undefined]) {
    const gated = structuredClone(enhanced);
    if (capability === undefined) delete gated.capabilities;
    else gated.capabilities.operationActivityDetail = capability;
    for (const field of operationFields) delete gated.events[0].detail[field];

    const result = operationDetailContract(gated);
    assert.equal(result.capability, false);
    assert.deepEqual(
      Object.values(result.operationFields),
      operationFields.map(() => "unknown"),
    );
    assert.equal(result.summary, null);
    assert.deepEqual(result.baseDetail, {
      actorName: "Brian",
      clientLabel: "Codex",
    });
  }
});

test("Recall skills spell out the fail-closed activity contract", async () => {
  const [recallSkill, journalSkill] = await Promise.all(
    [
      "plugins/recall/skills/recall/SKILL.md",
      "plugins/recall/skills/recall-journal/SKILL.md",
    ].map((relativePath) =>
      readFile(new URL(relativePath, repositoryRoot), "utf8"),
    ),
  );

  for (const skill of [recallSkill, journalSkill]) {
    for (const field of [
      "capabilities.activityDeltas",
      "available",
      "coverage",
      "cursorSupported",
      "truncated",
      "unavailableCount",
      "nextCursor",
      "changeSummaryTruncated",
    ]) {
      assert.ok(skill.includes(field), `expected ${field} in both skills`);
    }
    for (const field of operationFields) {
      assert.ok(skill.includes(field), `expected ${field} in both skills`);
    }
    assert.match(skill, /changeSummary` as untrusted agent-authored context/);
    assert.match(skill, /capabilities\.operationActivityDetail/);
    assert.match(
      skill,
      /false or missing[\s\S]+not that they were never\s+recorded/,
    );
  }

  assert.match(journalSkill, /do not\s+auto-migrate v1\/v2 global users/);
  assert.match(journalSkill, /explicit default Recall Project/);
  assert.match(journalSkill, /Do not fill an activity gap with\s+`list_note_activity`/);
  assert.match(
    journalSkill,
    /never create or update a legacy journal note or Today summary/,
  );
  assert.match(
    recallSkill,
    /omit both `format: "markdown"` and\s+`expectedRevision`/,
  );
});
