#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  JOURNAL_CONFIG_MAX_BYTES,
  canonicalProjectRoot,
  resolveFilesystemProjectRootSync,
} from "../../../bridge/journal-destinations.mjs";
import {
  CURRENT_JOURNAL_CONFIG_VERSION,
  JOURNAL_HOSTS,
  describeInvalidJournalConfig,
  isPlainObject,
  journalConfigPath,
  readJournalConfigFile,
  resolveSummaryTarget,
  sanitizeJournalConfig,
} from "../../../bridge/journal-config.mjs";

// The journal skill's upgrade helper. `plan` reads the current agent's
// recall-journal.json, classifies it, and prints the version 7 file it would
// become together with every consequence the user has to confirm and every
// question that still needs an answer. `apply` writes one confirmed version 7
// file atomically, after validating it with the same exact-shape rules the
// hook and the lifecycle adapter read with. Neither command talks to Recall:
// the live revalidation of every carried workspace and Project, the
// capability gate, and the user's confirmation all happen in the skill,
// between plan and apply, and nothing here ever runs from lifecycle context.

const TARGET = CURRENT_JOURNAL_CONFIG_VERSION;
const USAGE =
  "Usage: upgrade-journal-config plan --host claude-code|codex|cursor [--cwd <dir>]\n" +
  "       upgrade-journal-config apply --host claude-code|codex|cursor [--input <file>] [--expect-version <n>]";

function destinationOf(value) {
  return {
    workspace: { id: value.workspace.id, name: value.workspace.name },
    recallProject: { id: value.recallProject.id, name: value.recallProject.name },
  };
}

function workspaceOf(value) {
  return { id: value.workspace.id, name: value.workspace.name };
}

function label(destination) {
  const workspace = `workspace ${JSON.stringify(destination.workspace.name)} (${destination.workspace.id})`;
  return destination.recallProject
    ? `Project ${JSON.stringify(destination.recallProject.name)} (${destination.recallProject.id}) in ${workspace}`
    : `the root of ${workspace}`;
}

function scopeLabel(entry) {
  return entry.scope === "global"
    ? "global destination"
    : `filesystem-project destination for ${entry.root}`;
}

const CONSEQUENCES = {
  archive_untouched:
    "Existing journal notes, structured sessions, and Today cards remain readable and are never moved, rewritten, or deleted.",
  global_receives_unbound_repositories: (version) =>
    `Under version ${TARGET} the global destination also receives repository work whose remote is unbound, unsupported, or unresolved (resolve_project none, ambiguous, or not_ready), which version ${version} refused.`,
  journaling_turns_on:
    "This version 6 file has the pilot disabled and is inert: it emits no journal context at all. The same block under version 7 only keeps the pilot off, so converting turns automatic structured journaling on. If journaling should stay off, do not convert.",
  mode_change:
    "Legacy named-note journals stop receiving updates. New sessions and checkpoints are user-facing in Today -> Now activity, and Recall may create one app-owned Today card when the agent supplies a meaningful daySummary at close.",
  no_global_destination:
    "Without a global destination, exactly bound repositories still journal through the repository rung, and everything else outside the saved paths gets no project memory.",
  no_summary_preference:
    "The saved 'no day summary' preference has no version 7 equivalent: Recall may create a Today card at close. If an always-no-card preference is required, keep version 2.",
  pilot_kept:
    "The session-recording pilot stays enabled exactly as before under the version 7 sessionLifecycle block.",
  reader_becomes_writer: (version) =>
    `Version ${version} is reader-only; the version ${TARGET} file that replaces it is a writer. From the next prompt, agents open sessions, append checkpoints, and close with day summaries that appear in Today -> Now activity and on the Today timeline.`,
  routing_outside_saved_paths:
    "Outside a saved path, repository sessions use an exact supported Git-remote binding; no remote, none, ambiguous, or not_ready fall back to the global destination when one exists, otherwise that repository has no structured journal.",
  summary_target_replaced: (target) =>
    target === "dailyNote"
      ? "The retired DailyNote summary target disappears with the file: Recall creates the day card from close_session's daySummary instead."
      : "The Today summary setting is replaced by the app-owned day card that Recall creates from close_session's daySummary.",
};

function consequence(id, ...args) {
  const text = CONSEQUENCES[id];
  return { id, text: typeof text === "function" ? text(...args) : text };
}

function emptyPlan(file, filesystemProject) {
  return {
    targetVersion: TARGET,
    sourceVersion: Number.isInteger(file.version) ? file.version : null,
    filesystemProject,
    proposed: null,
    carried: [],
    dropped: [],
    consequences: [],
    questions: [],
  };
}

function planLegacy(raw, version, plan) {
  let globalDestination;
  const paths = {};
  const seenRoots = new Map();

  const keep = (scope, root, value) => {
    const destination = destinationOf(value);
    if (scope === "global") globalDestination = destination;
    else paths[root] = destination;
    plan.carried.push({ scope, ...(root ? { root } : {}), ...destination });
  };
  const drop = (scope, root, value, reason) => {
    plan.dropped.push({
      scope,
      ...(root ? { root } : {}),
      workspace: workspaceOf(value),
      ...(value.recallProject
        ? { recallProject: { ...value.recallProject } }
        : {}),
      reason,
    });
  };

  if (version === 1) {
    drop("global", null, { workspace: raw.workspace }, "workspace_root");
  } else if (raw.global !== undefined) {
    if (raw.global.recallProject) keep("global", null, raw.global);
    else drop("global", null, raw.global, "workspace_root");
  }
  for (const [root, entry] of Object.entries(raw.projects ?? {})) {
    const canonicalRoot = canonicalProjectRoot(root);
    if (seenRoots.has(canonicalRoot)) {
      drop("path", root, entry, "duplicate_root");
      continue;
    }
    seenRoots.set(canonicalRoot, root);
    if (version === 2 && entry.recallProject) keep("path", root, entry);
    else drop("path", root, entry, "workspace_root");
  }

  plan.consequences.push(consequence("mode_change"));
  plan.consequences.push(consequence("routing_outside_saved_paths"));
  const summaryTarget = resolveSummaryTarget(raw.journal, version === 2);
  plan.consequences.push(
    summaryTarget === "none"
      ? consequence("no_summary_preference")
      : consequence("summary_target_replaced", summaryTarget),
  );
  return { globalDestination, paths, sessionLifecycle: { enabled: false } };
}

function planStructured(raw, version, plan) {
  if (version === 3) {
    plan.consequences.push(consequence("reader_becomes_writer", 3));
    plan.questions.push({
      id: "choose_destination",
      required: true,
      text: `Version 3 saves no destination. Choose at least one for the version ${TARGET} file: a global Project, a Project for the current filesystem project, or both.`,
    });
    return {
      globalDestination: undefined,
      paths: {},
      sessionLifecycle: { enabled: false },
    };
  }

  const globalDestination = destinationOf(raw.projectMemory.defaultProject);
  plan.carried.push({ scope: "global", ...globalDestination });
  if (version === 4) plan.consequences.push(consequence("reader_becomes_writer", 4));
  plan.consequences.push(
    consequence("global_receives_unbound_repositories", version),
  );
  let sessionLifecycle = { enabled: false };
  if (version === 6) {
    sessionLifecycle = { ...raw.sessionLifecycle };
    plan.consequences.push(
      consequence(sessionLifecycle.enabled ? "pilot_kept" : "journaling_turns_on"),
    );
  }
  return { globalDestination, paths: {}, sessionLifecycle };
}

// Pure: takes a readJournalConfigFile result and the resolved filesystem
// project (or null) and returns the plan. `status` is one of missing,
// unreadable, invalid, current, upgradable, or needs_input; a plan is
// upgradable when a complete version 7 file can be proposed with nothing
// dropped, and needs_input when a required question must be answered first.
// Even an upgradable plan is only a proposal: every carried destination still
// has to be revalidated live and the user still has to confirm.
export function planJournalConfigUpgrade(file, { filesystemProject = null } = {}) {
  const plan = emptyPlan(file, filesystemProject);
  if (file.status === "missing") {
    plan.questions.push({
      id: "first_setup",
      required: true,
      text: "No journal config exists, so there is nothing to upgrade. Run first setup instead.",
    });
    return { status: "missing", ...plan };
  }
  if (file.status === "unreadable") {
    plan.questions.push({
      id: "unreadable",
      required: true,
      text: "The config file exists but could not be read. Check its permissions before doing anything else.",
    });
    return { status: "unreadable", ...plan };
  }
  if (file.status === "invalid") {
    const description = describeInvalidJournalConfig(file);
    plan.questions.push({
      id: "repair",
      required: true,
      text: `The file is not a valid journal config: ${description}. Show the user the problem and ask whether to replace it through first setup or leave it alone; never guess a destination from it.`,
    });
    return {
      status: "invalid",
      invalid: { reason: file.reason, description },
      ...plan,
    };
  }

  const { raw, version } = file;
  if (version === TARGET) {
    const { global: globalValue, paths: pathsValue } = raw.projectMemory;
    if (globalValue) plan.carried.push({ scope: "global", ...destinationOf(globalValue) });
    for (const [root, entry] of Object.entries(pathsValue ?? {})) {
      plan.carried.push({ scope: "path", root, ...destinationOf(entry) });
    }
    return { status: "current", ...plan };
  }

  const { globalDestination, paths, sessionLifecycle } =
    version <= 2
      ? planLegacy(raw, version, plan)
      : planStructured(raw, version, plan);

  for (const entry of plan.dropped) {
    if (entry.reason === "duplicate_root") {
      plan.questions.push({
        id: `resolve_duplicate:${entry.root}`,
        required: true,
        text: `The ${scopeLabel(entry)} resolves to the same directory as another saved path, and version ${TARGET} rejects duplicate roots. Keep exactly one entry for that directory.`,
      });
      continue;
    }
    plan.questions.push({
      id: `choose_project:${entry.scope}${entry.root ? `:${entry.root}` : ""}`,
      required: true,
      text: `The ${scopeLabel(entry)} journals at ${label(entry)}; structured destinations must name a Project. Choose one exact write-ready Project in that workspace for it, or drop it from the new file.`,
    });
  }
  if (globalDestination) {
    plan.questions.push({
      id: "global_project",
      required: false,
      text: `Keep ${label(globalDestination)} as the global destination, or choose a different write-ready workspace and Project for it. The global destination receives every session with no saved path, no repository identity, or no exact repository binding.`,
    });
  }
  const hasPaths = Object.keys(paths).length > 0;
  if (
    filesystemProject?.root &&
    !Object.keys(paths).some(
      (root) => canonicalProjectRoot(root) === filesystemProject.root,
    )
  ) {
    plan.questions.push({
      id: "add_current_path",
      required: false,
      text: `Optionally add a saved destination for the current filesystem project at ${filesystemProject.root}, naming a write-ready Project, so work there routes ahead of the repository binding and the global destination.`,
    });
  }
  if (!globalDestination && hasPaths) {
    plan.consequences.push(consequence("no_global_destination"));
  }
  plan.consequences.push(consequence("archive_untouched"));

  const proposed =
    globalDestination || hasPaths
      ? {
          version: TARGET,
          projectMemory: {
            enabled: true,
            ...(globalDestination ? { global: globalDestination } : {}),
            ...(hasPaths ? { paths } : {}),
          },
          sessionLifecycle,
        }
      : null;
  plan.proposed = proposed && sanitizeJournalConfig(proposed) ? proposed : null;
  const required = plan.questions.some((question) => question.required);
  return {
    status: required || !plan.proposed ? "needs_input" : "upgradable",
    ...plan,
  };
}

function summarize(file) {
  return {
    status: file.status,
    ...(file.version !== undefined ? { version: file.version } : {}),
    ...(file.reason !== undefined ? { reason: file.reason } : {}),
  };
}

// Writes one confirmed version 7 file: validate with the shared exact-shape
// rules, refuse anything over the shared size bound, optionally require the
// file on disk to still be the version the plan was made from, then write a
// temporary file beside the target and rename it into place.
export function applyJournalConfig(configPath, value, { expectVersion } = {}) {
  if (!isPlainObject(value) || value.version !== TARGET) {
    return {
      status: "rejected",
      reason: "unsupported_version",
      detail: `apply writes only version ${TARGET} files`,
    };
  }
  if (!sanitizeJournalConfig(value)) {
    return {
      status: "rejected",
      reason: "invalid_shape",
      detail: `the input is not an exact version ${TARGET} shape`,
    };
  }
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > JOURNAL_CONFIG_MAX_BYTES) {
    return {
      status: "rejected",
      reason: "oversized",
      detail: `the file would exceed ${JOURNAL_CONFIG_MAX_BYTES} bytes; drop destinations instead`,
    };
  }

  const current = readJournalConfigFile(configPath);
  if (current.status === "unreadable") {
    return { status: "rejected", reason: "unreadable", current: summarize(current) };
  }
  if (
    expectVersion !== undefined &&
    (current.status !== "valid" || current.version !== expectVersion)
  ) {
    return {
      status: "rejected",
      reason: "version_mismatch",
      detail: `expected a valid version ${expectVersion} file on disk`,
      current: summarize(current),
    };
  }

  const directory = path.dirname(configPath);
  const temporary = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, configPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* The temporary file was never created or is already gone. */
    }
    return {
      status: "failed",
      reason: "write_failed",
      detail: error?.message ?? String(error),
    };
  }

  const verified = readJournalConfigFile(configPath);
  return {
    status: "written",
    version: TARGET,
    previous: summarize(current),
    verified: verified.status === "valid" && verified.version === TARGET,
  };
}

export function parseUpgradeArguments(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "apply"].includes(command)) throw new TypeError(USAGE);
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new TypeError(`${flag} needs a value.\n${USAGE}`);
    switch (flag) {
      case "--host":
        options.host = value;
        break;
      case "--cwd":
        if (command !== "plan") throw new TypeError(`--cwd applies to plan only.\n${USAGE}`);
        options.cwd = value;
        break;
      case "--input":
        if (command !== "apply") throw new TypeError(`--input applies to apply only.\n${USAGE}`);
        options.input = value;
        break;
      case "--expect-version": {
        if (command !== "apply") {
          throw new TypeError(`--expect-version applies to apply only.\n${USAGE}`);
        }
        const version = Number(value);
        if (!Number.isInteger(version) || version < 1) {
          throw new TypeError(`--expect-version needs a positive integer.\n${USAGE}`);
        }
        options.expectVersion = version;
        break;
      }
      default:
        throw new TypeError(`Unknown option ${flag}.\n${USAGE}`);
    }
  }
  if (!JOURNAL_HOSTS.includes(options.host)) {
    throw new TypeError(`--host is required: ${JOURNAL_HOSTS.join(", ")}.\n${USAGE}`);
  }
  return options;
}

async function readStream(stream) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

export async function runUpgradeCommand(
  argv,
  { env = process.env, cwd = process.cwd(), stdin = process.stdin } = {},
) {
  const options = parseUpgradeArguments(argv);
  const configPath = journalConfigPath(options.host, env);

  if (options.command === "plan") {
    const file = readJournalConfigFile(configPath);
    const project = resolveFilesystemProjectRootSync(options.cwd ?? cwd, env);
    const filesystemProject = canonicalProjectRoot(project.root)
      ? { repository: project.repository, root: project.root }
      : null;
    return {
      exitCode: 0,
      output: {
        host: options.host,
        configPath,
        ...planJournalConfigUpgrade(file, { filesystemProject }),
      },
    };
  }

  let text;
  try {
    text = options.input
      ? fs.readFileSync(options.input, "utf8")
      : await readStream(stdin);
  } catch (error) {
    return {
      exitCode: 1,
      output: {
        host: options.host,
        configPath,
        status: "rejected",
        reason: "input_unreadable",
        detail: error?.message ?? String(error),
      },
    };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      exitCode: 1,
      output: {
        host: options.host,
        configPath,
        status: "rejected",
        reason: "malformed_json",
      },
    };
  }
  const result = applyJournalConfig(configPath, value, {
    expectVersion: options.expectVersion,
  });
  return {
    exitCode: result.status === "written" ? 0 : 1,
    output: { host: options.host, configPath, ...result },
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    const { exitCode, output } = await runUpgradeCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}
