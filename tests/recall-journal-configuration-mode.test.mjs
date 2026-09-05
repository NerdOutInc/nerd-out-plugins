import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("setup preserves an existing structured mode when coverage is missing", () => {
  const text = readFileSync(new URL("../plugins/recall/skills/recall-journal/references/configuration.md", import.meta.url), "utf8");
  assert.match(text, /Leave an existing v5 or v7 config and its configured mode unchanged/);
  assert.match(text, /skip writes/);
  assert.match(text, /first user-visible/);
  assert.match(text, /absence does not prove/);
  assert.doesNotMatch(text, /all-or-nothing fallback/);
});
