import path from "node:path";
import { pathToFileURL } from "node:url";

// These profiles are deliberately NOT included by a plugin manifest. Activation
// is explicit after per-host capability/behavior proof and Codex hook review.
// The default v5 hook remains unchanged for users who did not opt in.
export function lifecycleHookProfile(host) {
  if (!["claude-code", "codex"].includes(host))
    throw new Error("Unsupported lifecycle host.");
  const turn = host === "codex" ? "${turn_id}" : "${prompt_id}";
  const identity = {
    protocolVersion: 1,
    host,
    cwd: "${cwd}",
    conversationId: "${session_id}",
    participantId: "${agent_id}",
    turnId: turn,
  };
  const handler = (eventName, extra = {}) => ({
    type: "mcp_tool",
    server: host === "codex" ? "recall" : "plugin:recall:recall",
    tool: "session_lifecycle_hook",
    input: { ...identity, eventName, ...extra },
    timeout: 5,
  });
  const tools =
    host === "codex"
      ? "^(apply_patch|Bash|read_file|view_image)$"
      : "^(Edit|Write|Read|Bash|Glob|Grep)$";
  const toolFields = { toolName: "${tool_name}", toolUseId: "${tool_use_id}" };
  const hooks = {
    PreToolUse: [
      { matcher: tools, hooks: [handler("PreToolUse", toolFields)] },
    ],
    PostToolUse: [
      { matcher: tools, hooks: [handler("PostToolUse", toolFields)] },
    ],
    UserPromptSubmit: [{ hooks: [handler("UserPromptSubmit")] }],
    Stop: [{ hooks: [handler("Stop")] }],
  };
  if (host === "claude-code") {
    const clear = handler("SessionEnd", {
      endReason: "${reason}",
      requestId: "explicit-conversation-clear",
    });
    delete clear.input.turnId; // A conversation may be cleared before a prompt.
    hooks.SessionEnd = [{ matcher: "^clear$", hooks: [clear] }];
  }
  return { hooks };
}

// Read-only setup output: merge these entries through the host's supported hook
// settings workflow, then review Codex trust in /hooks. No config/cache writes,
// trust-hash copying, auto-enablement, or separate MCP connection is performed.
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--host" ||
    !["claude-code", "codex"].includes(args[1])
  ) {
    process.stderr.write(
      "Usage: session-lifecycle-profiles.mjs --host claude-code|codex\n",
    );
    process.exitCode = 2;
  } else
    process.stdout.write(
      `${JSON.stringify(lifecycleHookProfile(args[1]), null, 2)}\n`,
    );
}
