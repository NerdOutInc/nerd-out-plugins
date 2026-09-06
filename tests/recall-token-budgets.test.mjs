import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { measureCatalog, measureHook, measureSkills } from "../scripts/measure-context-cost.mjs";

// Every byte the plugin puts into an agent's context has a ceiling here, so a
// wording change that quietly grows the per-prompt reminder or the skill bundle
// fails in CI instead of in every user's transcript. The numbers are UTF-8
// bytes; docs/token-usage-optimization-plan.md explains where they come from.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/recall-journal-hook");
const KIB = 1024;
const BUDGETS = {
  hookSessionStartup: 4.25 * KIB,
  hookSessionCompact: 4.5 * KIB,
  hookReminder: 400,
  hookAbsentConnectorReminder: 640,
  hookInvalidConfigReminder: 256,
  hookCursorSession: 4.5 * KIB,
  dispatcher: 4.5 * KIB,
  writer: 12 * KIB,
  projectContext: 4.5 * KIB,
  efforts: 9 * KIB,
  effortsRecovery: 4 * KIB,
  ordinaryBundle: 21.5 * KIB,
  effortsBundle: 30 * KIB,
  descriptionJournal: 400,
  descriptionDoctor: 256,
  descriptionRecall: 160,
};

const bytes = (text) => Buffer.byteLength(text, "utf8");

function goldens(predicate) {
  const rows = [];
  for (const version of fs.readdirSync(fixtureRoot)) {
    const directory = path.join(fixtureRoot, version);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const filename of fs.readdirSync(directory)) {
      if (!filename.endsWith(".txt") || !predicate(filename)) continue;
      rows.push([`${version}/${filename}`, bytes(fs.readFileSync(path.join(directory, filename), "utf8").trimEnd())]);
    }
  }
  assert.ok(rows.length > 0, "expected at least one golden");
  return rows;
}

test("every session-start golden stays under its budget", () => {
  for (const [name, size] of goldens((filename) => filename.endsWith("-context.txt"))) {
    assert.ok(size <= BUDGETS.hookSessionStartup, `${name}: ${size} > ${BUDGETS.hookSessionStartup}`);
  }
});

test("every per-prompt reminder golden stays under its budget", () => {
  for (const [name, size] of goldens((filename) => filename.endsWith("reminder.txt"))) {
    const budget = name.includes("bridge-missing") ? BUDGETS.hookAbsentConnectorReminder : BUDGETS.hookReminder;
    assert.ok(size <= budget, `${name}: ${size} > ${budget}`);
  }
});

test("the live hook stays under budget on every route and event, compaction included", () => {
  for (const row of measureHook()) {
    if (row.route.includes("Cursor")) {
      assert.ok(row.sessionStart <= BUDGETS.hookCursorSession, `${row.route}: ${row.sessionStart}`);
      continue;
    }
    assert.ok(row.sessionStart <= BUDGETS.hookSessionStartup, `${row.route} startup: ${row.sessionStart}`);
    assert.ok(row.sessionCompact <= BUDGETS.hookSessionCompact, `${row.route} compact: ${row.sessionCompact}`);
    assert.ok(row.prompt <= BUDGETS.hookReminder, `${row.route} prompt: ${row.prompt}`);
    // On the writer routes the reminder is the every-prompt cost, so it must
    // stay a small fraction of the once-per-session context it points back at.
    if (row.route.includes("writer")) {
      assert.ok(row.prompt * 8 < row.sessionStart, `${row.route}: reminder ${row.prompt} is not small beside ${row.sessionStart}`);
    }
  }
});

test("an invalid config produces a short per-prompt reminder", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-budget-"));
  try {
    fs.writeFileSync(path.join(directory, "recall-journal.json"), JSON.stringify({ version: 5, projectMemory: { enabled: true } }));
    const environment = { ...process.env, CODEX_HOME: directory, PLUGIN_ROOT: path.join(repositoryRoot, "plugins/recall") };
    delete environment.CLAUDE_CONFIG_DIR;
    delete environment.CLAUDE_PLUGIN_ROOT;
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "plugins/recall/hooks/journal-context.mjs")], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repositoryRoot }),
    });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(bytes(context) <= BUDGETS.hookInvalidConfigReminder, `${bytes(context)}`);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("the journal skill references and bundles stay under budget", () => {
  const skills = measureSkills();
  const expectations = [
    ["recall-journal/SKILL.md", BUDGETS.dispatcher],
    ["structured-writer.md", BUDGETS.writer],
    ["project-context.md", BUDGETS.projectContext],
    ["efforts.md", BUDGETS.efforts],
    ["efforts-recovery.md", BUDGETS.effortsRecovery],
  ];
  for (const [name, budget] of expectations) {
    assert.ok(skills.files[name] <= budget, `${name}: ${skills.files[name]} > ${budget}`);
  }
  assert.ok(
    skills.bundles["v5/v7 ordinary (dispatcher, writer, project context)"] <= BUDGETS.ordinaryBundle,
    `ordinary bundle: ${skills.bundles["v5/v7 ordinary (dispatcher, writer, project context)"]}`,
  );
  assert.ok(skills.bundles["v5/v7 with efforts"] <= BUDGETS.effortsBundle, `efforts bundle: ${skills.bundles["v5/v7 with efforts"]}`);
  // Recovery is read only on failure, so it must stay out of the efforts basics.
  const efforts = fs.readFileSync(path.join(repositoryRoot, "plugins/recall/skills/recall-journal/references/efforts.md"), "utf8");
  assert.match(efforts, /Read \[efforts-recovery\.md\]\(efforts-recovery\.md\) only when/);
  assert.doesNotMatch(efforts, /resume_milestone|freshMilestoneAllowed|pendingCursor/);
});

test("the always-on skill descriptions stay short", () => {
  const { descriptions } = measureSkills();
  assert.ok(descriptions["recall-journal"] <= BUDGETS.descriptionJournal, String(descriptions["recall-journal"]));
  assert.ok(descriptions.doctor <= BUDGETS.descriptionDoctor, String(descriptions.doctor));
  assert.ok(descriptions.recall <= BUDGETS.descriptionRecall, String(descriptions.recall));
});

test("the catalog fixture is the generation the guidance was measured against", () => {
  const catalog = measureCatalog();
  assert.equal(catalog.catalogVersion, 8);
  assert.equal(catalog.toolCount, 40);
  // Six tools carry the evidence schema. Generation 8 dropped its flattened
  // item-level copy, so the whole catalog is smaller than generation 7's
  // 64,938 bytes even with read_entry added.
  assert.equal(catalog.evidenceTools, 6);
  assert.ok(catalog.descriptionBytes + catalog.schemaBytes < 64_938, String(catalog.descriptionBytes + catalog.schemaBytes));
  assert.ok(catalog.coreFive > 0 && catalog.journalingTen > catalog.coreFive);
});

test("the measurement script prints every table", () => {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/measure-context-cost.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const heading of ["## Journal hook", "## Skill bundles", "## Tool catalog fixture", "## Cost model"]) {
    assert.ok(result.stdout.includes(heading), heading);
  }
  const json = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/measure-context-cost.mjs"), "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), ["catalog", "hook", "model", "skills"]);
});
