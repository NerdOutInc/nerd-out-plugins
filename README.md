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
