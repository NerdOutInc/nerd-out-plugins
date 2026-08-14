import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const fixtureRoot = new URL(
  "fixtures/recall-skill-capabilities/",
  import.meta.url
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
      Object.hasOwn(updateProperties, "expectedRevision")
  };
}

test("capability fixtures require the complete revision-safe pair", async () => {
  const [enhanced, legacy] = await Promise.all([
    readJson(new URL("enhanced.json", fixtureRoot)),
    readJson(new URL("legacy.json", fixtureRoot))
  ]);

  assert.deepEqual(advertisedCapabilities(enhanced), {
    activity: true,
    revisionSafeMarkdown: true
  });
  const activitySchema = requireTool(enhanced, "list_note_activity").inputSchema;
  assert.equal(activitySchema.properties.limit.maximum, 50);
  assert.deepEqual(activitySchema.required, ["uuid"]);
  assert.deepEqual(advertisedCapabilities(legacy), {
    activity: false,
    revisionSafeMarkdown: false
  });

  const missingMarkdown = structuredClone(enhanced);
  requireTool(
    missingMarkdown,
    "read_note"
  ).inputSchema.properties.format.enum = ["text", "html", "both"];
  assert.equal(
    advertisedCapabilities(missingMarkdown).revisionSafeMarkdown,
    false
  );

  const missingExpectedRevision = structuredClone(enhanced);
  delete requireTool(
    missingExpectedRevision,
    "update_note_content"
  ).inputSchema.properties.expectedRevision;
  assert.equal(
    advertisedCapabilities(missingExpectedRevision).revisionSafeMarkdown,
    false
  );

  const missingActivity = structuredClone(enhanced);
  missingActivity.tools = missingActivity.tools.filter(
    ({ name }) => name !== "list_note_activity"
  );
  assert.deepEqual(advertisedCapabilities(missingActivity), {
    activity: false,
    revisionSafeMarkdown: true
  });
});

test("Recall skills document capability-gated activity and conditional writes", async () => {
  const [recallSkill, journalSkill] = await Promise.all(
    [
      "plugins/recall/skills/recall/SKILL.md",
      "plugins/recall/skills/recall-journal/SKILL.md"
    ].map((relativePath) =>
      readFile(new URL(relativePath, repositoryRoot), "utf8")
    )
  );

  for (const skill of [recallSkill, journalSkill]) {
    assert.match(skill, /list_note_activity.*advertised/s);
    assert.match(skill, /read_note.*"markdown".*format.*enum/s);
    assert.match(skill, /update_note_content.*expectedRevision/s);
    assert.match(skill, /(?:Require both|Both conditions)/);
    assert.match(skill, /nextCursor/);
    assert.match(skill, /[Nn]ever\s+(?:decode|infer)/);
    assert.match(
      skill,
      /(?:[Rr]e-read|Call\s+`read_note` again).*format: "markdown"/s
    );
    assert.match(skill, /[Nn]ever (?:reuse|replay).*stale/s);
  }

  assert.match(
    recallSkill,
    /omit both `format: "markdown"` and\s+`expectedRevision`/
  );
  assert.match(journalSkill, /omit both enhanced inputs/);
});

test("structured v3 remains exclusive from every legacy note capability", async () => {
  const [journalSkill, v3Context] = await Promise.all([
    readFile(
      new URL("plugins/recall/skills/recall-journal/SKILL.md", repositoryRoot),
      "utf8"
    ),
    readFile(
      new URL("../recall-journal-hook/v3/additional-context.txt", fixtureRoot),
      "utf8"
    )
  ]);
  const v3Start = journalSkill.indexOf("One compatibility exception");
  const v3End = journalSkill.indexOf("### Legacy named-note capabilities");
  assert.notEqual(v3Start, -1, "expected the structured v3 section");
  assert.ok(v3End > v3Start, "expected legacy capabilities after structured v3");
  const v3Section = journalSkill.slice(v3Start, v3End);

  assert.match(v3Section, /Select this protocol before/);
  assert.match(v3Section, /do not run the legacy capability probe/);
  for (const legacyTool of [
    "list_note_activity",
    "read_note",
    "update_note_content"
  ]) {
    assert.equal(v3Section.includes("`" + legacyTool + "`"), true, legacyTool);
    assert.equal(v3Context.includes(legacyTool), false, legacyTool);
  }
});
