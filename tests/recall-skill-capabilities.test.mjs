import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const fixtureRoot = new URL(
  "fixtures/recall-skill-capabilities/",
  import.meta.url,
);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function requireTool(catalog, name) {
  const tool = catalog.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} in fixture catalog`);
  return tool;
}

function advertisedCapabilities(catalog) {
  const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const readFormats =
    tools.get("read_note")?.inputSchema?.properties?.format?.enum ?? [];
  const updateProperties =
    tools.get("update_note_content")?.inputSchema?.properties ?? {};

  return {
    activity: tools.has("list_note_activity"),
    revisionSafeMarkdown:
      readFormats.includes("markdown") &&
      Object.hasOwn(updateProperties, "expectedRevision"),
    strictAgentMutation:
      readFormats.includes("markdown") &&
      Object.hasOwn(updateProperties, "expectedRevision") &&
      Object.hasOwn(updateProperties, "idempotencyKey") &&
      Object.hasOwn(updateProperties, "changeSummary"),
  };
}

test("capability fixtures require the complete revision-safe pair", async () => {
  const [enhanced, legacy] = await Promise.all([
    readJson(new URL("enhanced.json", fixtureRoot)),
    readJson(new URL("legacy.json", fixtureRoot)),
  ]);

  assert.deepEqual(advertisedCapabilities(enhanced), {
    activity: true,
    revisionSafeMarkdown: true,
    strictAgentMutation: true,
  });
  const activitySchema = requireTool(
    enhanced,
    "list_note_activity",
  ).inputSchema;
  assert.equal(activitySchema.properties.limit.maximum, 50);
  assert.deepEqual(activitySchema.required, ["uuid"]);
  assert.deepEqual(advertisedCapabilities(legacy), {
    activity: false,
    revisionSafeMarkdown: false,
    strictAgentMutation: false,
  });

  const missingMarkdown = structuredClone(enhanced);
  requireTool(missingMarkdown, "read_note").inputSchema.properties.format.enum =
    ["text", "html", "both"];
  assert.equal(
    advertisedCapabilities(missingMarkdown).revisionSafeMarkdown,
    false,
  );
  assert.equal(
    advertisedCapabilities(missingMarkdown).strictAgentMutation,
    false,
  );

  const missingExpectedRevision = structuredClone(enhanced);
  delete requireTool(missingExpectedRevision, "update_note_content").inputSchema
    .properties.expectedRevision;
  assert.equal(
    advertisedCapabilities(missingExpectedRevision).revisionSafeMarkdown,
    false,
  );
  assert.equal(
    advertisedCapabilities(missingExpectedRevision).strictAgentMutation,
    false,
  );

  for (const field of ["idempotencyKey", "changeSummary"]) {
    const missingStrictField = structuredClone(enhanced);
    delete requireTool(missingStrictField, "update_note_content").inputSchema
      .properties[field];
    assert.equal(
      advertisedCapabilities(missingStrictField).revisionSafeMarkdown,
      true,
      field,
    );
    assert.equal(
      advertisedCapabilities(missingStrictField).strictAgentMutation,
      false,
      field,
    );
  }

  const missingActivity = structuredClone(enhanced);
  missingActivity.tools = missingActivity.tools.filter(
    ({ name }) => name !== "list_note_activity",
  );
  assert.deepEqual(advertisedCapabilities(missingActivity), {
    activity: false,
    revisionSafeMarkdown: true,
    strictAgentMutation: true,
  });
});

test("Recall skills document capability-gated activity and conditional writes", async () => {
  const [recallSkill, journalSkill] = await Promise.all(
    [
      "plugins/recall/skills/recall/SKILL.md",
      "plugins/recall/skills/recall-journal/SKILL.md",
    ].map((relativePath) =>
      readFile(new URL(relativePath, repositoryRoot), "utf8"),
    ),
  );

  for (const skill of [recallSkill, journalSkill]) {
    assert.match(skill, /list_note_activity.*advertised/s);
    assert.match(skill, /read_note.*"markdown".*format.*enum/s);
    assert.match(skill, /update_note_content.*expectedRevision/s);
    assert.match(skill, /(?:Require both|Both conditions)/);
    assert.match(
      skill,
      /expectedRevision`, `idempotencyKey`, and\s+`changeSummary`/,
    );
    assert.match(skill, /partial bundle is rejected/);
    assert.match(skill, /NamedNote/);
    assert.match(
      skill,
      /omit both `(?:changeSummary|idempotencyKey)` and `(?:idempotencyKey|changeSummary)`/,
    );
    assert.match(skill, /nextCursor/);
    assert.match(skill, /[Nn]ever\s+(?:decode|infer)/);
    assert.match(
      skill,
      /(?:[Rr]e-read|Call\s+`read_note` again).*format: "markdown"/s,
    );
    assert.match(skill, /[Nn]ever (?:reuse|replay).*stale/s);
  }

  assert.match(
    recallSkill,
    /omit both `format: "markdown"` and\s+`expectedRevision`/,
  );
  assert.match(journalSkill, /omit both enhanced inputs/);
});

test("structured v3 and v4 stay exclusive from every legacy note capability", async () => {
  const [journalSkill, v3Context, v4Context] = await Promise.all([
    readFile(
      new URL("plugins/recall/skills/recall-journal/SKILL.md", repositoryRoot),
      "utf8",
    ),
    readFile(
      new URL("../recall-journal-hook/v3/additional-context.txt", fixtureRoot),
      "utf8",
    ),
    readFile(
      new URL("../recall-journal-hook/v4/repository-context.txt", fixtureRoot),
      "utf8",
    ),
  ]);
  const structuredStart = journalSkill.indexOf("One compatibility exception");
  const structuredEnd = journalSkill.indexOf(
    "### Legacy named-note capabilities",
  );
  assert.notEqual(structuredStart, -1, "expected the structured-mode section");
  assert.ok(
    structuredEnd > structuredStart,
    "expected legacy capabilities after structured modes",
  );
  const structuredSection = journalSkill.slice(structuredStart, structuredEnd);

  assert.match(structuredSection, /Select this protocol before/);
  assert.match(structuredSection, /do not run the legacy capability probe/);
  for (const legacyTool of [
    "list_note_activity",
    "read_note",
    "update_note_content",
  ]) {
    assert.equal(
      structuredSection.includes("`" + legacyTool + "`"),
      true,
      legacyTool,
    );
    for (const context of [v3Context, v4Context]) {
      assert.equal(context.includes(legacyTool), false, legacyTool);
    }
  }
});
