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

function readValidJournalConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const journal = config?.journal;
    const hasValidJournalSettings =
      journal === undefined ||
      (journal !== null &&
        typeof journal === "object" &&
        !Array.isArray(journal) &&
        (journal.dailyNote === undefined ||
          typeof journal.dailyNote === "boolean"));

    // Keep this strict. Before any writer emits a newer config version, ship
    // compatible readers first so older plugin installs do not go silent.
    const isValid =
      config?.version === 1 &&
      config?.scope === "global" &&
      typeof config?.workspace?.id === "string" &&
      config.workspace.id.length > 0 &&
      typeof config?.workspace?.name === "string" &&
      config.workspace.name.length > 0 &&
      hasValidJournalSettings;
    if (!isValid) return null;

    // The name is display-only, so flatten and truncate it. The id is passed
    // back to the search tools and rendered unquoted, so rather than repair
    // it, require a plain single-line token and stay silent otherwise.
    const name = sanitizeWorkspaceField(config.workspace.name).slice(0, 80);
    const { id } = config.workspace;
    if (!name || !/^[\w.:-]{1,128}$/.test(id)) return null;

    return { ...config, workspace: { id, name } };
  } catch {
    return null;
  }
}

function buildHookOutput(input, env = process.env) {
  if (input?.hook_event_name !== "UserPromptSubmit") return null;

  const context = resolveJournalContext(env);
  const config = readValidJournalConfig(context.configPath);
  if (!config) return null;

  // Name the workspace and its id here so the agent can search the journal
  // immediately, without loading the skill or re-reading the config first.
  const { workspace } = config;

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        // JSON.stringify keeps the quoted name unambiguous even when it
        // contains quotes or backslashes.
        `Automatic Nerd Out journaling is enabled for ${context.agentName} by a valid per-agent config bound to the NerdOut workspace ${JSON.stringify(workspace.name)} (workspaceId ${workspace.id}). ` +
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
