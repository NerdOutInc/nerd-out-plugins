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

function hasValidJournalConfig(configPath) {
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
    return (
      config?.version === 1 &&
      config?.scope === "global" &&
      typeof config?.workspace?.id === "string" &&
      config.workspace.id.length > 0 &&
      typeof config?.workspace?.name === "string" &&
      config.workspace.name.length > 0 &&
      hasValidJournalSettings
    );
  } catch {
    return false;
  }
}

function buildHookOutput(input, env = process.env) {
  if (input?.hook_event_name !== "UserPromptSubmit") return null;

  const context = resolveJournalContext(env);
  if (!hasValidJournalConfig(context.configPath)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        `Automatic Nerd Out journaling is enabled for ${context.agentName} by a valid per-agent config. ` +
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
