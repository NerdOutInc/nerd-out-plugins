import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readModeGuidanceSync, readSkillGuidanceSync } from "./helpers/read-skill-guidance.mjs";

const skill = new URL("../plugins/recall/skills/recall-journal/SKILL.md", import.meta.url);
const cases = [
  ["v3/v4 structured readers", ["structured-readers.md", "project-context.md"], /never create a\s+structured session/i, /### One note per chat thread/],
  ["v5/v7 structured writer", ["structured-writer.md", "efforts.md"], /entrySyncStatus/, /### One note per chat thread/],
  ["v6 conversation-segment pilot, including enabled v7 `sessionLifecycle`", ["conversation-segments.md"], /begin_session_recording/, /### One note per chat thread/],
  ["v1/v2 legacy notes", ["legacy-notes.md"], /One note per chat thread/, /## Structured journaling/],
];
for (const [label, names, required, forbidden] of cases) {
  test(`loads the isolated ${label} instruction bundle`, () => {
    const bundle = readModeGuidanceSync(skill, label);
    assert.deepEqual(bundle.direct, names.map((name) => `references/${name}`));
    assert.match(bundle.text, required);
    assert.doesNotMatch(bundle.text, forbidden);
  });
}
test("a structured-to-legacy routing mutation cannot borrow another mode's instructions", () => {
  const mutated = readFileSync(skill, "utf8").replace(
    /\| v5\/v7 structured writer \|[^\n]+/,
    "| v5/v7 structured writer | [legacy-notes.md](references/legacy-notes.md) |",
  );
  const bundle = readModeGuidanceSync(skill, "v5/v7 structured writer", mutated);
  assert.doesNotMatch(bundle.text, /entrySyncStatus/);
  assert.notDeepEqual(bundle.direct, ["references/structured-writer.md", "references/efforts.md"]);
});
test("every packaged reference remains readable independently of mode selection", () => {
  assert.ok(readSkillGuidanceSync(skill).length > 0);
});
