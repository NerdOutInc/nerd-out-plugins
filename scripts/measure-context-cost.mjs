#!/usr/bin/env node
// Prints what the Recall plugin puts into an agent's context, in UTF-8 bytes:
// the journal hook by route and event, the skill bundle by mode, the tool
// catalog by subset (from the checked-in generation fixture), and a per-session
// cost model. Bytes only; tokens are roughly bytes divided by four for English
// prose, and nothing here is billed usage. Pass --json for machine output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModeGuidanceSync } from "../tests/helpers/read-skill-guidance.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins/recall");
const hookScript = path.join(pluginRoot, "hooks/journal-context.mjs");
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/recall-journal-hook");
const skillRoot = path.join(pluginRoot, "skills");
const catalogFixture = path.join(repositoryRoot, "tests/fixtures/recall-catalog/generation-7.json");
const THREAD_ID = "11111111-2222-4333-8444-555555555555";

const bytes = (text) => Buffer.byteLength(text, "utf8");
const read = (relativePath) => fs.readFileSync(path.join(skillRoot, relativePath), "utf8");

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "CODEX_HOME", "CURSOR_HOME", "PLUGIN_ROOT"]) {
    delete environment[name];
  }
  return environment;
}

function runHook(environment, input, args = []) {
  const result = spawnSync(process.execPath, [hookScript, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify(input),
  });
  if (result.status !== 0) throw new Error(result.stderr || `hook exited ${result.status}`);
  if (!result.stdout) return "";
  const output = JSON.parse(result.stdout);
  return output.additional_context ?? output.hookSpecificOutput?.additionalContext ?? "";
}

export function measureHook() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recall-measure-"));
  const noRepository = fs.mkdtempSync(path.join(temporary, "no-repository-"));
  try {
    const codex = (version) => ({ ...cleanEnvironment(), CODEX_HOME: path.join(fixtureRoot, version), PLUGIN_ROOT: pluginRoot });
    const claude = (version) => ({ ...cleanEnvironment(), CLAUDE_CONFIG_DIR: path.join(fixtureRoot, version), CLAUDE_PLUGIN_ROOT: pluginRoot });
    const routes = [
      ["v1 legacy, Codex", codex("v1"), repositoryRoot],
      ["v2 legacy, Codex", codex("v2"), repositoryRoot],
      ["v3 reader, Codex", codex("v3"), repositoryRoot],
      ["v4 reader, repository, Codex", codex("v4"), repositoryRoot],
      ["v4 reader, no repository, Codex", codex("v4"), noRepository],
      ["v5 writer, repository, Codex", codex("v5"), repositoryRoot],
      ["v5 writer, repository, Claude Code", claude("v5"), repositoryRoot],
      ["v5 writer, no repository, Codex", codex("v5"), noRepository],
      ["v7 writer, repository with global, Codex", codex("v7"), repositoryRoot],
      ["v7 writer, global, Codex", codex("v7"), noRepository],
    ];
    const rows = routes.map(([label, environment, cwd]) => {
      const base = { cwd, session_id: THREAD_ID };
      return {
        route: label,
        sessionStart: bytes(runHook(environment, { ...base, hook_event_name: "SessionStart", source: "startup" })),
        sessionCompact: bytes(runHook(environment, { ...base, hook_event_name: "SessionStart", source: "compact" })),
        prompt: bytes(runHook(environment, { ...base, hook_event_name: "UserPromptSubmit" })),
      };
    });
    rows.push({
      route: "v5 writer, Cursor sessionStart",
      sessionStart: bytes(
        runHook(
          { ...cleanEnvironment(), CURSOR_HOME: path.join(fixtureRoot, "v5") },
          { hook_event_name: "sessionStart", workspace_roots: [repositoryRoot], conversation_id: THREAD_ID },
          ["--host", "cursor"],
        ),
      ),
      sessionCompact: null,
      prompt: null,
    });
    return rows;
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

export function measureSkills() {
  const skill = path.join(skillRoot, "recall-journal/SKILL.md");
  const files = {
    "recall-journal/SKILL.md": read("recall-journal/SKILL.md"),
    "structured-writer.md": read("recall-journal/references/structured-writer.md"),
    "project-context.md": read("recall-journal/references/project-context.md"),
    "efforts.md": read("recall-journal/references/efforts.md"),
    "efforts-recovery.md": read("recall-journal/references/efforts-recovery.md"),
    "structured-readers.md": read("recall-journal/references/structured-readers.md"),
    "conversation-segments.md": read("recall-journal/references/conversation-segments.md"),
    "codex-preflight.md": read("recall-journal/references/codex-preflight.md"),
    "configuration.md": read("recall-journal/references/configuration.md"),
    "legacy-notes.md": read("recall-journal/references/legacy-notes.md"),
    "recall/SKILL.md": read("recall/SKILL.md"),
    "doctor/SKILL.md": read("doctor/SKILL.md"),
  };
  const sizes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, bytes(text)]));
  const description = (text) => bytes(/^description:\s*(.*)$/m.exec(text)?.[1] ?? "");
  return {
    files: sizes,
    bundles: {
      "v5/v7 ordinary (dispatcher, writer, project context)": sizes["recall-journal/SKILL.md"] + sizes["structured-writer.md"] + sizes["project-context.md"],
      "v5/v7 with efforts": sizes["recall-journal/SKILL.md"] + sizes["structured-writer.md"] + sizes["project-context.md"] + sizes["efforts.md"],
      "v5/v7 with effort recovery": sizes["recall-journal/SKILL.md"] + sizes["structured-writer.md"] + sizes["project-context.md"] + sizes["efforts.md"] + sizes["efforts-recovery.md"],
      "v3/v4 readers (dispatcher, readers, project context)": sizes["recall-journal/SKILL.md"] + sizes["structured-readers.md"] + sizes["project-context.md"],
      "v1/v2 legacy closure (test helper)": bytes(readModeGuidanceSync(skill, "v1/v2 legacy notes").text),
    },
    descriptions: {
      "recall-journal": description(files["recall-journal/SKILL.md"]),
      recall: description(files["recall/SKILL.md"]),
      doctor: description(files["doctor/SKILL.md"]),
    },
  };
}

export function measureCatalog() {
  const catalog = JSON.parse(fs.readFileSync(catalogFixture, "utf8"));
  const tools = catalog.tools.map((tool) => ({
    name: tool.name,
    description: bytes(tool.description ?? ""),
    schema: bytes(JSON.stringify(tool.inputSchema ?? {})),
    evidence: tool.inputSchema?.properties?.evidence ? bytes(JSON.stringify(tool.inputSchema.properties.evidence)) : 0,
  }));
  const subset = (names) =>
    tools.filter((tool) => names.includes(tool.name)).reduce((total, tool) => total + tool.description + tool.schema, 0);
  return {
    catalogVersion: catalog.catalogVersion,
    toolCount: tools.length,
    descriptionBytes: tools.reduce((total, tool) => total + tool.description, 0),
    schemaBytes: tools.reduce((total, tool) => total + tool.schema, 0),
    evidenceBytes: tools.reduce((total, tool) => total + tool.evidence, 0),
    evidenceTools: tools.filter((tool) => tool.evidence > 0).length,
    coreFive: subset(["resolve_project", "open_session", "get_project_context", "append_entry", "close_session"]),
    journalingTen: subset([
      "resolve_project", "open_session", "get_project_context", "append_entry", "close_session",
      "record_milestone", "open_effort", "list_efforts", "read_effort", "bind_effort",
    ]),
    largest: [...tools].sort((a, b) => b.description + b.schema - (a.description + a.schema)).slice(0, 6),
  };
}

// One Claude Code session under the v5/v7 writer. Response sizes are the
// September 2026 measurements from the plan; hook and skill sizes are live.
export function costModel(hook, skills, catalog) {
  const v5 = hook.find((row) => row.route === "v5 writer, repository, Claude Code");
  const responses = { resolve: 140, openBase: 800, openPerOtherSession: 800, context: 22570, appendEcho: 1500, close: 500 };
  const scenarios = [
    ["Short task: 3 prompts, 2 entries", 3, 2, false],
    ["Typical task: 10 prompts, 3 entries", 10, 3, false],
    ["Long session: 25 prompts, 4 entries", 25, 4, false],
    ["Effort session: 10 prompts, 3 milestones", 10, 3, true],
  ];
  return scenarios.map(([scenario, prompts, entries, efforts]) => {
    const before = 4066 * prompts + 22315 + (efforts ? 11379 : 0) + (efforts ? 28562 : 16449);
    const after = v5.sessionStart + v5.sessionCompact + v5.prompt * prompts + (efforts ? skills.bundles["v5/v7 with efforts"] : 0) + (efforts ? catalog.journalingTen : catalog.coreFive);
    const shared = responses.resolve + responses.openBase + responses.openPerOtherSession * 2 + responses.context + responses.appendEcho * entries + responses.close + 450 + 1200 * entries + 1800;
    return { scenario, before: before + shared, after: after + shared };
  });
}

function table(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map((cell) => (cell == null ? "" : String(cell))).join(" | ")} |`);
  return lines.join("\n");
}

function main() {
  const hook = measureHook();
  const skills = measureSkills();
  const catalog = measureCatalog();
  const model = costModel(hook, skills, catalog);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ catalog, hook, model, skills }, null, 2)}\n`);
    return;
  }
  const out = [];
  out.push("## Journal hook (bytes per event)\n", table(["Route", "SessionStart startup", "SessionStart compact", "UserPromptSubmit"], hook.map((row) => [row.route, row.sessionStart, row.sessionCompact, row.prompt])));
  out.push("\n## Skill files (bytes)\n", table(["File", "Bytes"], Object.entries(skills.files)));
  out.push("\n## Skill bundles (bytes)\n", table(["Bundle", "Bytes"], Object.entries(skills.bundles)));
  out.push("\n## Skill descriptions, loaded in every session (bytes)\n", table(["Skill", "Bytes"], Object.entries(skills.descriptions)));
  out.push(`\n## Tool catalog fixture (generation ${catalog.catalogVersion}, ${catalog.toolCount} tools)\n`, table(["Measure", "Bytes"], [
    ["descriptions", catalog.descriptionBytes],
    ["input schemas", catalog.schemaBytes],
    [`evidence property across ${catalog.evidenceTools} tools`, catalog.evidenceBytes],
    ["core five journaling tools", catalog.coreFive],
    ["ten journaling tools with efforts", catalog.journalingTen],
  ]));
  out.push("\n## Largest tools (description + schema bytes)\n", table(["Tool", "Description", "Schema"], catalog.largest.map((tool) => [tool.name, tool.description, tool.schema])));
  out.push("\n## Cost model, one Claude Code session (bytes; responses fixed at the September 2026 measurements)\n", table(["Scenario", "Plugin 0.38.0", "Now", "Cut"], model.map((row) => [row.scenario, row.before, row.after, `${Math.round((1 - row.after / row.before) * 100)}%`])));
  process.stdout.write(`${out.join("\n")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
