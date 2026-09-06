import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOURNAL_CONFIG_MAX_BYTES,
  canonicalProjectRoot,
} from "./journal-destinations.mjs";

// Every reader of recall-journal.json — the per-prompt journal hook, the
// version 6 lifecycle context, and the journal skill's upgrade helper —
// validates the file through this module, so one exact shape per version is
// defined once and a file can never be valid to one reader and invalid to
// another. Nothing here writes a file: lifecycle context never rewrites,
// migrates, or downgrades a config, and the only writer is the skill's
// explicit, confirmed upgrade helper.

export const JOURNAL_CONFIG_FILENAME = "recall-journal.json";
export const CURRENT_JOURNAL_CONFIG_VERSION = 7;
export const SUPPORTED_JOURNAL_CONFIG_VERSIONS = Object.freeze([
  1, 2, 3, 4, 5, 6, 7,
]);
export const JOURNAL_HOSTS = Object.freeze(["claude-code", "codex", "cursor"]);

export function journalConfigDirectory(host, env = process.env) {
  return host === "cursor"
    ? env.CURSOR_HOME || path.join(os.homedir(), ".cursor")
    : host === "codex"
      ? env.CODEX_HOME || path.join(os.homedir(), ".codex")
      : env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function journalConfigPath(host, env = process.env) {
  return path.join(journalConfigDirectory(host, env), JOURNAL_CONFIG_FILENAME);
}

export function journalAgentName(host) {
  return host === "cursor"
    ? "Cursor"
    : host === "codex"
      ? "Codex"
      : "Claude Code";
}

export function journalSkillName(host) {
  return host === "cursor"
    ? "/recall-journal"
    : host === "codex"
      ? "$recall:recall-journal"
      : "/recall:recall-journal";
}

// Workspace fields flow from the shared Recall service into every prompt's
// context, so force them onto one short line before interpolation.
function sanitizeWorkspaceField(value) {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The name is display-only, so flatten and truncate it. The id is passed back
// to the search tools and rendered unquoted, so rather than repair it, require
// a plain single-line token and reject the workspace otherwise.
function sanitizeWorkspace(workspace) {
  if (
    typeof workspace?.id !== "string" ||
    typeof workspace?.name !== "string"
  ) {
    return null;
  }
  const name = sanitizeWorkspaceField(workspace.name).slice(0, 80);
  if (!name || !/^[\w.:-]{1,128}$/.test(workspace.id)) return null;
  return { id: workspace.id, name };
}

function sanitizeRecallProject(project) {
  if (typeof project?.id !== "string" || typeof project?.name !== "string") {
    return null;
  }
  const name = sanitizeWorkspaceField(project.name).slice(0, 80);
  if (!name || !/^[\w.:-]{1,128}$/.test(project.id)) return null;
  return { id: project.id, name };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function sanitizeV3ProjectMemoryConfig(config) {
  if (!isPlainObject(config.projectMemory)) return null;
  if (config.projectMemory.enabled !== true) return null;

  // Version 3 is an exclusive, reader-only activation signal. Reject legacy
  // destinations instead of choosing one of two journal protocols, and keep
  // the initial contract deliberately small until the structured writer ships.
  const topLevelKeys = Object.keys(config);
  if (
    topLevelKeys.some((key) => key !== "version" && key !== "projectMemory") ||
    !hasOnlyKeys(config.projectMemory, ["enabled"])
  ) {
    return null;
  }

  return { projectMemory: { version: 3 } };
}

// Structured destinations are exact: a workspace and a Recall Project, each
// carrying only an id and a name. A workspace-root destination is invalid
// because every structured record is Project-scoped end to end.
export function sanitizeStructuredDestination(value) {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["workspace", "recallProject"]) ||
    !isPlainObject(value.workspace) ||
    !hasOnlyKeys(value.workspace, ["id", "name"]) ||
    !isPlainObject(value.recallProject) ||
    !hasOnlyKeys(value.recallProject, ["id", "name"])
  ) {
    return null;
  }

  const destination = sanitizeDestination(value);
  return destination?.recallProject ? destination : null;
}

function sanitizeDefaultProjectConfig(config, version) {
  if (!isPlainObject(config.projectMemory)) return null;
  if (config.projectMemory.enabled !== true) return null;
  if (!hasOnlyKeys(config, ["version", "projectMemory"])) return null;
  if (!hasOnlyKeys(config.projectMemory, ["enabled", "defaultProject"])) {
    return null;
  }

  const destination = sanitizeStructuredDestination(
    config.projectMemory.defaultProject,
  );
  if (!destination) return null;
  return { projectMemory: { defaultProject: destination, version } };
}

function sanitizeV4ProjectMemoryConfig(config) {
  return sanitizeDefaultProjectConfig(config, 4);
}

function sanitizeV5ProjectMemoryConfig(config) {
  return sanitizeDefaultProjectConfig(config, 5);
}

// The pilot block has the same two keys, with the same meanings, under
// version 6 (where it is required) and version 7 (where it is optional):
// exactly what bridge/session-lifecycle-routing.mjs reads for routing.
function sanitizeSessionLifecycle(value, { required = false } = {}) {
  if (value === undefined) return required ? null : { enabled: false };
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["enabled", "codexParticipantVerified"]) ||
    typeof value.enabled !== "boolean" ||
    (value.codexParticipantVerified !== undefined &&
      typeof value.codexParticipantVerified !== "boolean")
  ) {
    return null;
  }
  return value.codexParticipantVerified === undefined
    ? { enabled: value.enabled }
    : {
        codexParticipantVerified: value.codexParticipantVerified,
        enabled: value.enabled,
      };
}

// Version 6 is routed by the lifecycle adapter, never by the prompt hook.
// This reader only has to tell a valid pilot file — enabled or deliberately
// inert — from an invalid one, so it applies the adapter's exact-shape rules,
// including its longer name bound, without any of its routing.
function sanitizeV6ProjectMemoryConfig(config) {
  if (!isPlainObject(config.projectMemory)) return null;
  if (config.projectMemory.enabled !== true) return null;
  if (!hasOnlyKeys(config, ["version", "projectMemory", "sessionLifecycle"])) {
    return null;
  }
  if (!hasOnlyKeys(config.projectMemory, ["enabled", "defaultProject"])) {
    return null;
  }

  const rawDestination = config.projectMemory.defaultProject;
  const destination = sanitizeStructuredDestination(rawDestination);
  if (
    !destination ||
    [rawDestination.workspace.name, rawDestination.recallProject.name].some(
      (name) => name.length > 256,
    )
  ) {
    return null;
  }
  const sessionLifecycle = sanitizeSessionLifecycle(config.sessionLifecycle, {
    required: true,
  });
  if (!sessionLifecycle) return null;
  return {
    projectMemory: { defaultProject: destination, version: 6 },
    sessionLifecycle,
  };
}

// Version 7 restores the version 2 destination model to the structured
// writer: an optional global destination plus optional per-path destinations,
// at least one of which must exist. Every destination names a Project.
function sanitizeV7ProjectMemoryConfig(config) {
  if (!isPlainObject(config.projectMemory)) return null;
  if (config.projectMemory.enabled !== true) return null;
  if (!hasOnlyKeys(config, ["version", "projectMemory", "sessionLifecycle"])) {
    return null;
  }
  if (!hasOnlyKeys(config.projectMemory, ["enabled", "global", "paths"])) {
    return null;
  }

  const { global: globalValue, paths: pathsValue } = config.projectMemory;
  const globalDestination =
    globalValue === undefined
      ? undefined
      : sanitizeStructuredDestination(globalValue);
  if (globalValue !== undefined && !globalDestination) return null;
  const projects = sanitizeProjectDestinations(
    pathsValue,
    sanitizeStructuredDestination,
    { rejectDuplicateRoots: true },
  );
  if (!projects || (!globalDestination && projects.length === 0)) return null;

  const sessionLifecycle = sanitizeSessionLifecycle(config.sessionLifecycle);
  if (!sessionLifecycle) return null;
  return {
    projectMemory: { globalDestination, projects, version: 7 },
    sessionLifecycle,
  };
}

export function resolveSummaryTarget(journal, supportsSummaryTarget) {
  if (journal === undefined) return "dailyNote";
  if (!isPlainObject(journal)) return null;
  if (
    journal.dailyNote !== undefined &&
    typeof journal.dailyNote !== "boolean"
  ) {
    return null;
  }

  // Version 1 remains exactly backward compatible. Newer fields on a legacy
  // file never silently change its DailyNote behavior.
  if (!supportsSummaryTarget || journal.summaryTarget === undefined) {
    return journal.dailyNote === false ? "none" : "dailyNote";
  }

  if (!["today", "dailyNote", "none"].includes(journal.summaryTarget)) {
    return null;
  }
  const canonicalDailyNote = journal.summaryTarget === "dailyNote";
  if (journal.dailyNote !== canonicalDailyNote) {
    return null;
  }
  return journal.summaryTarget;
}

export function sanitizeDestination(value) {
  if (!isPlainObject(value)) return null;
  const workspace = sanitizeWorkspace(value.workspace);
  if (!workspace) return null;

  const hasRecallProject = Object.prototype.hasOwnProperty.call(
    value,
    "recallProject",
  );
  const recallProject = hasRecallProject
    ? sanitizeRecallProject(value.recallProject)
    : undefined;
  if (hasRecallProject && !recallProject) return null;

  return recallProject ? { recallProject, workspace } : { workspace };
}

// Keys are canonicalized before the filesystem-root check, so a key that is
// merely a symlink to the root cannot prefix-match every session and silently
// turn a per-project override into a global one. Version 7 additionally
// rejects two keys that canonicalize to the same directory, because "longest
// root wins" cannot choose between them honestly.
export function sanitizeProjectDestinations(
  projectsValue,
  sanitizeEntry = sanitizeDestination,
  { rejectDuplicateRoots = false } = {},
) {
  if (projectsValue === undefined) return [];
  if (!isPlainObject(projectsValue)) return null;

  const projects = [];
  const seenRoots = new Set();
  for (const [root, entry] of Object.entries(projectsValue)) {
    const canonicalRoot = canonicalProjectRoot(root);
    if (!canonicalRoot) return null;
    if (rejectDuplicateRoots && seenRoots.has(canonicalRoot)) return null;
    seenRoots.add(canonicalRoot);
    const destination = sanitizeEntry(entry);
    if (!destination) return null;
    projects.push({ destination, root: canonicalRoot });
  }
  return projects;
}

function sanitizeLegacyConfig(config) {
  if (config.version === 1) {
    const summaryTarget = resolveSummaryTarget(config.journal, false);
    if (!summaryTarget) return null;
    if (config.scope !== "global") return null;
    const globalDestination = sanitizeDestination({
      workspace: config.workspace,
    });
    // v1 project entries only define a workspace. Ignore newer destination
    // fields so a manually augmented legacy config keeps its old behavior.
    const projects = sanitizeProjectDestinations(config.projects, (entry) =>
      sanitizeDestination({ workspace: entry?.workspace }),
    );
    if (!globalDestination || !projects) return null;
    return { globalDestination, projects, summaryTarget };
  }

  const summaryTarget = resolveSummaryTarget(config.journal, true);
  if (!summaryTarget) return null;
  const globalDestination =
    config.global === undefined ? undefined : sanitizeDestination(config.global);
  const projects = sanitizeProjectDestinations(config.projects);
  if (
    (config.global !== undefined && !globalDestination) ||
    !projects ||
    (!globalDestination && projects.length === 0)
  ) {
    return null;
  }
  return { globalDestination, projects, summaryTarget };
}

// The sanitized form of one parsed config, or null when the value is not an
// exact instance of the version it names. Legacy versions return their
// destinations and summary target; structured versions return the
// projectMemory shape the hook routes on, plus the pilot block for 6 and 7.
export function sanitizeJournalConfig(config) {
  if (!isPlainObject(config)) return null;
  switch (config.version) {
    case 1:
    case 2:
      return sanitizeLegacyConfig(config);
    case 3:
      return sanitizeV3ProjectMemoryConfig(config);
    case 4:
      return sanitizeV4ProjectMemoryConfig(config);
    case 5:
      return sanitizeV5ProjectMemoryConfig(config);
    case 6:
      return sanitizeV6ProjectMemoryConfig(config);
    case 7:
      return sanitizeV7ProjectMemoryConfig(config);
    default:
      return null;
  }
}

// Classify the file on disk without ever choosing a destination for it:
//   missing    — no file, which is simply "journaling is not configured";
//   unreadable — the file exists but this process cannot read it;
//   invalid    — the file exists but is not any supported version's exact
//                shape (`reason` says why, `version` when the file named one);
//   valid      — `version`, the sanitized `config`, and the parsed `raw` file.
export function readJournalConfigFile(configPath) {
  let size;
  try {
    size = fs.statSync(configPath).size;
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  // The adapter enforces the same bound, so an oversized file is invalid to
  // both readers rather than valid to one and silently lost by the other.
  if (size > JOURNAL_CONFIG_MAX_BYTES) {
    return { reason: "oversized", status: "invalid" };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    if (error instanceof SyntaxError) {
      return { reason: "malformed_json", status: "invalid" };
    }
    return { status: "unreadable" };
  }

  const version = raw?.version;
  if (!SUPPORTED_JOURNAL_CONFIG_VERSIONS.includes(version)) {
    return {
      reason:
        Number.isInteger(version) && version > CURRENT_JOURNAL_CONFIG_VERSION
          ? "newer_version"
          : "unsupported_version",
      status: "invalid",
      ...(Number.isInteger(version) ? { version } : {}),
    };
  }
  const config = sanitizeJournalConfig(raw);
  if (!config) return { reason: "invalid_shape", status: "invalid", version };
  return { config, raw, status: "valid", version };
}

// The prompt hook's view: a valid version 1–5 or 7 file, or nothing. Version
// 6 is routed by the lifecycle adapter, so it reads as nothing here too.
export function readValidJournalConfig(configPath) {
  const file = readJournalConfigFile(configPath);
  return file.status === "valid" && file.version !== 6 ? file.config : null;
}

export function describeInvalidJournalConfig(file) {
  switch (file?.reason) {
    case "oversized":
      return "it is larger than the 64 KiB bound";
    case "malformed_json":
      return "it is not valid JSON";
    case "newer_version":
      return `its version ${file.version} is newer than this plugin supports, so the plugin may need updating`;
    case "unsupported_version":
      return file.version === undefined
        ? "its version field is missing or is not a supported number"
        : `version ${file.version} is not a supported journal config version`;
    default:
      return `its contents do not match the exact version ${file?.version} shape`;
  }
}

// One sentence for the hook and the lifecycle context alike. It reports that
// an upgrade exists and hands the decision to the user through the skill; it
// never authorizes a rewrite, and it is deliberately short because it rides
// on every prompt.
export function upgradeAvailableContext(version, skillName) {
  return ` This config is version ${version}; version ${CURRENT_JOURNAL_CONFIG_VERSION} is the current shape. Once per session, when finalizing meaningful work (immediately on an explicit invocation), offer to upgrade it to version ${CURRENT_JOURNAL_CONFIG_VERSION} through ${skillName}, which explains the consequences and writes only after the user confirms; leave the file unchanged if they decline or do not answer, and never rewrite it from this context.`;
}
