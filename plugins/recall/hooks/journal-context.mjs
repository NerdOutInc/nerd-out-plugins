import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIT_RESOLUTION_TIMEOUT_MS = 2_000;

function resolveJournalContext(env = process.env) {
  // Codex sets both root variables for Claude plugin compatibility; Claude Code
  // sets only CLAUDE_PLUGIN_ROOT, so the unprefixed variable identifies Codex.
  const isCodex = Boolean(env.PLUGIN_ROOT);
  const configDirectory = isCodex
    ? env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

  return {
    agentName: isCodex ? "Codex" : "Claude Code",
    configPath: path.join(configDirectory, "recall-journal.json"),
    skillName: isCodex ? "$recall:recall-journal" : "/recall:recall-journal",
  };
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

// The host's session id is rendered unquoted and echoed into journal metadata
// lines, so require a plain single-line token rather than repairing it.
function sanitizeThreadId(value) {
  return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value)
    ? value
    : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveSummaryTarget(journal, supportsSummaryTarget) {
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

function sanitizeDestination(value) {
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

function sanitizeProjectDestinations(
  projectsValue,
  sanitizeEntry = sanitizeDestination,
) {
  if (projectsValue === undefined) return [];
  if (!isPlainObject(projectsValue)) return null;

  const projects = [];
  for (const [root, entry] of Object.entries(projectsValue)) {
    if (!path.isAbsolute(root)) return null;
    // A key that resolves to the filesystem root would prefix-match every
    // session, silently turning a per-project override into a global one.
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot === path.parse(resolvedRoot).root) return null;
    const destination = sanitizeEntry(entry);
    if (!destination) return null;
    projects.push({ destination, root });
  }
  return projects;
}

function readValidJournalConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    if (config?.version === 1) {
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

    if (config?.version === 2) {
      const summaryTarget = resolveSummaryTarget(config.journal, true);
      if (!summaryTarget) return null;
      const globalDestination =
        config.global === undefined
          ? undefined
          : sanitizeDestination(config.global);
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

    return null;
  } catch {
    return null;
  }
}

// Compare real paths so a project root saved with (or without) symlinks in it
// still matches the session's working directory.
function normalizeDirectory(directory) {
  const resolved = path.resolve(directory);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsideDirectory(directory, root) {
  const relativeDirectory = path.relative(root, directory);
  return (
    relativeDirectory === "" ||
    (relativeDirectory !== ".." &&
      !relativeDirectory.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeDirectory))
  );
}

// Project bindings use the main checkout's path as their stable identity, but
// Codex and Claude Code may place linked worktrees elsewhere on disk. Preserve
// the current subdirectory while mapping it onto the main checkout before
// matching configured project roots. If Git is unavailable or this is not a
// normal non-bare checkout, retain the existing filesystem-only behavior.
function resolveCanonicalWorkingDirectory(workingDirectory, env) {
  const currentDirectory = normalizeDirectory(workingDirectory);
  const gitEnvironment = { ...env, GIT_TERMINAL_PROMPT: "0" };
  delete gitEnvironment.GIT_COMMON_DIR;
  delete gitEnvironment.GIT_DIR;
  delete gitEnvironment.GIT_WORK_TREE;

  const result = spawnSync(
    "git",
    [
      "-C",
      currentDirectory,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    {
      encoding: "utf8",
      env: gitEnvironment,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_RESOLUTION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    return currentDirectory;
  }

  const lines = result.stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
    return currentDirectory;
  }

  const checkoutRoot = normalizeDirectory(lines[0]);
  const commonDirectory = normalizeDirectory(lines[1]);
  if (
    path.basename(commonDirectory) !== ".git" ||
    !isInsideDirectory(currentDirectory, checkoutRoot)
  ) {
    return currentDirectory;
  }

  const mainCheckoutRoot = normalizeDirectory(path.dirname(commonDirectory));
  const relativeDirectory = path.relative(checkoutRoot, currentDirectory);
  return normalizeDirectory(path.join(mainCheckoutRoot, relativeDirectory));
}

// A project entry covers its saved root and everything under it, so sessions
// started in a subfolder inherit the project workspace. Linked worktrees are
// first mapped to the equivalent path under the main checkout, whether they
// live inside the repo or in an agent-managed external worktree directory. The
// longest matching root wins when saved projects nest.
function resolveProjectDestination(projects, workingDirectory, env) {
  if (projects.length === 0) return null;
  const currentDirectory = resolveCanonicalWorkingDirectory(
    workingDirectory,
    env,
  );
  let bestRoot = null;
  let bestDestination = null;
  for (const { destination, root } of projects) {
    const projectRoot = normalizeDirectory(root);
    const rootPrefix = projectRoot.endsWith(path.sep)
      ? projectRoot
      : projectRoot + path.sep;
    if (
      currentDirectory !== projectRoot &&
      !currentDirectory.startsWith(rootPrefix)
    ) {
      continue;
    }
    if (bestRoot === null || projectRoot.length > bestRoot.length) {
      bestRoot = projectRoot;
      bestDestination = destination;
    }
  }
  return bestDestination;
}

function destinationLabel(destination) {
  const workspace = `Recall workspace ${JSON.stringify(destination.workspace.name)} (workspaceId ${destination.workspace.id})`;
  return destination.recallProject
    ? `${workspace} and Recall Project ${JSON.stringify(destination.recallProject.name)} (projectId ${destination.recallProject.id})`
    : workspace;
}

function buildHookOutput(input, env = process.env) {
  if (input?.hook_event_name !== "UserPromptSubmit") return null;

  const context = resolveJournalContext(env);
  const config = readValidJournalConfig(context.configPath);
  if (!config) return null;

  // Both agents pass the session's working directory in the hook input; the
  // hook process's own working directory is the fallback. Path normalization
  // resolves a relative value against the process working directory, so a
  // provided cwd is honored in either form.
  const workingDirectory =
    typeof input.cwd === "string" && input.cwd.length > 0
      ? input.cwd
      : process.cwd();
  const projectDestination = resolveProjectDestination(
    config.projects,
    workingDirectory,
    env,
  );

  const destination = projectDestination ?? config.globalDestination;
  // A v2 config may intentionally cover only one filesystem project. Outside
  // its saved roots there is no implicit global journal, so stay silent.
  if (!destination) return null;

  // Name the workspace and optional Project id here so the agent can search the journal
  // immediately, without loading the skill or re-reading the config first.
  // JSON.stringify keeps the quoted names unambiguous even when they contain
  // quotes or backslashes.
  const binding = projectDestination
    ? `Automatic Recall journaling is enabled for ${context.agentName} by a valid per-agent config. This session's filesystem project is bound to ${destinationLabel(projectDestination)}${config.globalDestination ? `, a per-project override of the global workspace ${JSON.stringify(config.globalDestination.workspace.name)}` : ""}; use that destination for all journal recall and named-note writes this session. `
    : `Automatic Recall journaling is enabled for ${context.agentName} by a valid per-agent config bound globally to ${destinationLabel(destination)}. `;
  const projectTargeting = destination.recallProject
    ? `For named-note create, list, keyword, and semantic operations, pass both workspaceId ${destination.workspace.id} and projectId ${destination.recallProject.id}. `
    : `Target named-note create, list, keyword, and semantic operations with workspaceId ${destination.workspace.id}; this destination does not select a Recall Project. `;
  // The host's session id anchors the thread's single journal note, so the
  // agent can find it again after context compaction without guessing.
  const threadId =
    sanitizeThreadId(input.session_id) ?? sanitizeThreadId(input.thread_id);
  const threadIdentity = threadId
    ? `This chat thread's stable id is ${threadId}; it anchors the thread's single journal note across context compaction. `
    : "";
  const summaryTarget =
    config.summaryTarget === "today"
      ? `The journal summary target is the Today timeline: on each day this thread wraps up meaningful work, create exactly one tiny ELI5 Today card with create_today_note, workspaceId ${destination.workspace.id}${destination.recallProject ? `, projectId ${destination.recallProject.id}` : ""}, ${threadId ? "the thread id" : "the thread's first journal marker"} plus the date as idempotencyKey, one or two plain sentences followed by a '### Full journal entry' heading, and one backlink titled with the journal note's current title; never update DailyNote for this mode. `
      : config.summaryTarget === "dailyNote"
        ? `The configured day-summary target is the legacy DailyNote, which the Recall server has retired: a missing DailyNote can no longer be created, so never write or append a DailyNote summary. Journal and finalize the detailed named-note entry normally with no day summary; when finalizing meaningful work, ask the user once whether to switch this journal's summary target to the Today timeline (offered only when create_today_note is advertised) or to no day summary, and apply the choice through the migration flow in ${context.skillName}. `
        : "This journal disables day-summary notes; finalize only the detailed named-note entry. ";

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        binding +
        projectTargeting +
        threadIdentity +
        summaryTarget +
        `That journal is also ${context.agentName}'s memory: when this task may relate to previously journaled work — ongoing projects, earlier decisions or fixes, or context the user assumes is known — search that configured destination with the Recall keyword_search tool (plus semantic_search when available), read the relevant notes before deciding, and cite any note that informs the response. ` +
        `For this turn, if the task will produce durable decisions, implementation work, test results, blockers, or follow-ups, load and follow ${context.skillName} when substantive work begins: this chat thread keeps exactly one journal note, so open it (or continue it) after recall, append human-readable toggle entries at checkpoints while working, and wrap up the entry before the final response. ` +
        "Skip trivial acknowledgements and do not prompt for journal setup merely because this implicit reminder fired.",
    },
  };
}

async function main() {
  try {
    let rawInput = "";
    for await (const chunk of process.stdin) rawInput += chunk;
    const output = buildHookOutput(JSON.parse(rawInput));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // A journaling reminder must never block or break the user's prompt.
  }
}

await main();
