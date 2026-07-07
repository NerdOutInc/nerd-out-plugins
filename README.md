# Nerd Out Plugins

Plugins and agent integrations for Nerd Out products.

## Codex Plugins

Install the Nerd Out Notes Codex plugin into the current project:

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins/plugins/nerd-out-notes --plugin --project
```

Install all Codex plugins in this repository:

```bash
npx codex-marketplace add NerdOutInc/nerd-out-plugins --plugins --project
```

## Nerd Out Notes

`plugins/nerd-out-notes` connects Codex to the local MCP server hosted by the
Nerd Out Notes Mac app. The plugin does not run a notes server itself; it points
Codex at the loopback endpoint already managed by the signed-in Mac app.

To use it:

1. Open Nerd Out Notes for Mac.
2. Go to Settings -> MCP Server.
3. Enable the local MCP server.
4. Authorize Codex (browser sign-in + consent):

```bash
codex mcp login nerd-out-notes
```

If `codex mcp login` can't find the server, run `codex mcp list` to see the
exact name Codex registered it under and use that. Older app builds without
OAuth support can still use the shared bearer token — see the legacy setup
section in the [plugin README](plugins/nerd-out-notes/README.md).

Start a new Codex thread after installing and authorizing so the plugin tools
are loaded.

Write tools only appear when "Allow writes" is enabled in Nerd Out Notes
settings.
