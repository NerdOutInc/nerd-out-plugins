# Nerd Out Plugins

Plugins and agent integrations for Nerd Out products.

## Codex Plugins

### Install from the Codex app

Open **Plugins**, choose **Create -> Add plugin marketplace**, and enter:

- Source: `https://github.com/NerdOutInc/nerd-out-plugins`
- Git ref: `main`
- Sparse paths: leave blank to load the whole marketplace, or enter both paths
  below on separate lines:

```text
.agents/plugins
plugins/nerd-out-notes
```

The marketplace manifest and plugin directory must both be included in a sparse
checkout. Add the marketplace, then install **Nerd Out Notes** from the Nerd Out
marketplace.

### Install from the command line

Install the Nerd Out Notes Codex plugin globally (available in every project):

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins/plugins/nerd-out-notes --plugin --global
```

Install all Codex plugins in this repository:

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins --plugins --global
```

To scope a plugin to the current repository instead, swap `--global` for `--project`.

## Claude Code Plugins

The same plugins work in Claude Code. Add this repository as a plugin
marketplace, then install the plugin:

```text
/plugin marketplace add NerdOutInc/nerd-out-plugins
/plugin install nerd-out-notes@nerd-out
```

Or from the command line (user scope makes the plugin available in every
project, which fits this plugin since it talks to the per-user Mac app):

```bash
claude plugin marketplace add NerdOutInc/nerd-out-plugins
claude plugin install nerd-out-notes@nerd-out --scope user
```

## Nerd Out Notes

`plugins/nerd-out-notes` connects Codex or Claude Code to the local MCP server
hosted by the Nerd Out Notes Mac app. The plugin does not run a notes server
itself; it points the agent at the loopback endpoint already managed by the
signed-in Mac app.

To use it:

1. Open Nerd Out Notes for Mac.
2. Go to Settings -> MCP Server.
3. Enable the local MCP server.
4. Authorize your agent (browser sign-in + consent).

For Codex:

```bash
codex mcp login nerd-out-notes
```

If `codex mcp login` can't find the server, run `codex mcp list` to see the
exact name Codex registered it under and use that.

For Claude Code, run `/mcp` in a session and authenticate the Nerd Out Notes
server. Plugin servers are namespaced, so it appears as
`plugin:nerd-out-notes:nerd-out-notes`; `claude mcp list` shows the exact name.

Older app builds without OAuth support can still use the shared bearer token —
see the legacy setup section in the
[plugin README](plugins/nerd-out-notes/README.md).

Start a new thread after installing and authorizing so the plugin tools are
loaded.

Write tools only appear when "Allow writes" is enabled in Nerd Out Notes
settings.

The plugin supports multiple skills in its `skills/` directory. In addition to
the direct note workflow, the journal skill
(`$nerd-out-notes:nerd-out-journal` in Codex,
`/nerd-out-notes:nerd-out-journal` in Claude Code) configures a per-agent global
`nerd-out-journal.json` workspace selection. A bundled per-prompt hook detects
that valid opt-in config, reminds the agent to search prior journal notes for
relevant context when a task relates to earlier work, and reminds it to keep
concise named-note and DailyNote summaries for meaningful work in that
write-ready workspace. Asking the agent to select a workspace for the current
project adds a per-project override to the same config, so sessions working
anywhere inside that project's folder (worktrees included) journal to the
project's own workspace instead of the global one.

After installing or updating the plugin, start a new thread so its skills,
tools, and hook are loaded. Codex requires a one-time review and trust decision
for the plugin hook; open `/hooks` if Codex reports that the hook is awaiting
review. The hook only reads the per-agent journal config and adds agent context;
the journal skill still validates the live workspace and performs every note
write through the Nerd Out MCP server.
