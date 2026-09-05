import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("Effort guidance distinguishes the timeline projection from delivery", () => {
  const reference = new URL("../plugins/recall/skills/recall-journal/references/efforts.md", import.meta.url);
  const source = existsSync(reference) ? reference : new URL("../plugins/recall/skills/recall-journal/SKILL.md", import.meta.url);
  const text = readFileSync(source, "utf8");
  assert.match(text, /Read `noteSyncStatus`, `entrySyncStatus`, `entry`/);
  assert.match(text, /both `open_effort` and `record_milestone`/);
  assert.match(text, /Retain and report queued entry delivery/);
  assert.match(text, /entry presence is not a sync receipt/);
});
