import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveJournalContext(env = process.env) {
  // Codex sets both root variables for Claude plugin compatibility; Claude Code
  // sets only CLAUDE_PLUGIN_ROOT, so the unprefixed variable identifies Codex.
  const isCodex = Boolean(env.PLUGIN_ROOT);
  const configDirectory = isCodex
    ? env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

  return {
    agentName: isCodex ? "Codex" : "Claude Code",
    configPath: path.join(configDirectory, "nerd-out-journal.json"),
    skillName: isCodex
      ? "$nerd-out-notes:nerd-out-journal"
      : "/nerd-out-notes:nerd-out-journal",
  };
}

// Workspace fields flow from the shared NerdOut service into every prompt's
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readValidJournalConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const journal = config?.journal;
    const hasValidJournalSettings =
      journal === undefined ||
      (isPlainObject(journal) &&
        (journal.dailyNote === undefined ||
          typeof journal.dailyNote === "boolean"));

    // Keep this strict. Before any writer emits a newer config version, ship
    // compatible readers first so older plugin installs do not go silent.
    // `projects` stays optional and additive for the same reason: configs
    // that carry it still validate under readers that predate it.
    if (
      config?.version !== 1 ||
      config?.scope !== "global" ||
      !hasValidJournalSettings
    ) {
      return null;
    }

    const workspace = sanitizeWorkspace(config.workspace);
    if (!workspace) return null;

    const projects = [];
    if (config.projects !== undefined) {
      if (!isPlainObject(config.projects)) return null;
      for (const [root, entry] of Object.entries(config.projects)) {
        if (!path.isAbsolute(root) || !isPlainObject(entry)) return null;
        const projectWorkspace = sanitizeWorkspace(entry.workspace);
        if (!projectWorkspace) return null;
        projects.push({ root, workspace: projectWorkspace });
      }
    }

    return { workspace, projects };
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

// A project entry covers its saved root and everything under it, so sessions
// started in a subfolder — or in a worktree checked out inside the repo, such
// as <repo>/.claude/worktrees/<name> — inherit the project workspace. The
// longest matching root wins when saved projects nest.
function resolveProjectWorkspace(projects, workingDirectory) {
  const currentDirectory = normalizeDirectory(workingDirectory);
  let bestRoot = null;
  let bestWorkspace = null;
  for (const { root, workspace } of projects) {
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
      bestWorkspace = workspace;
    }
  }
  return bestWorkspace;
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
  const projectWorkspace = resolveProjectWorkspace(
    config.projects,
    workingDirectory,
  );

  // Name the workspace and its id here so the agent can search the journal
  // immediately, without loading the skill or re-reading the config first.
  // JSON.stringify keeps the quoted names unambiguous even when they contain
  // quotes or backslashes.
  const binding = projectWorkspace
    ? `Automatic Nerd Out journaling is enabled for ${context.agentName} by a valid per-agent config. This session's project is bound to the NerdOut workspace ${JSON.stringify(projectWorkspace.name)} (workspaceId ${projectWorkspace.id}), a per-project override of the global workspace ${JSON.stringify(config.workspace.name)}; use the project workspace for all journal recall and writes this session. `
    : `Automatic Nerd Out journaling is enabled for ${context.agentName} by a valid per-agent config bound to the NerdOut workspace ${JSON.stringify(config.workspace.name)} (workspaceId ${config.workspace.id}). `;

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        binding +
        `That journal is also ${context.agentName}'s memory: when this task may relate to previously journaled work — ongoing projects, earlier decisions or fixes, or context the user assumes is known — search that workspace with the Nerd Out keyword_search tool (plus semantic_search when available), read the relevant notes before deciding, and cite any note that informs the response. ` +
        `For this turn, load and follow ${context.skillName} before the final response if the task produces durable decisions, implementation work, test results, blockers, or follow-ups. ` +
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
