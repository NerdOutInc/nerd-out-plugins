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
4. Reveal the access token.
5. Export the token before starting Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-nerd-out-notes>"
```

Write tools only appear when "Allow writes" is enabled in Nerd Out Notes
settings.
