# Recall Plugins

AI plugins for the Recall notes app.

## Install from Recall for Mac

Open **Settings → Integrations** in Recall for Mac. The direct-download build
can detect Claude Code and Codex, install this marketplace and the Recall
plugin, enable the local MCP listener, and prepare the pinned ACP runtime with
one click. The sandboxed App Store build links to the verified manual steps
below.

Installation does not silently authorize note access. Plugin `0.14.0` adds
tiny, retry-safe Today timeline journal summaries while retaining Project-aware
destinations from `0.13.0`, the OAuth coordinator from `0.12.0`, read + write
consent-scope alignment from `0.12.1`, and Codex hook trust preflight from
`0.12.2`.
Compatible Direct Recall builds can present the existing explicit consent page
inside Recall while writing the exact Claude or Codex credential cache. Older
Recall builds and normal plugin first use retain the browser flow. Workspace
block/read/write access remains a separate setting in every path.

## Codex Plugins

### Install from the Codex app

Open **Plugins**, choose **Create -> Add plugin marketplace**, and enter:

- Source: `https://github.com/NerdOutInc/recall-plugins`
- Git ref: `main`
- Sparse paths: leave blank to load the whole marketplace, or enter both paths
  below on separate lines:

```text
.agents/plugins
plugins/recall
```

The marketplace manifest and plugin directory must both be included in a sparse
checkout. Add the marketplace, then install **Recall** from the Recall
marketplace.

### Install from the command line

Install the Recall Codex plugin globally (available in every project):

```bash
codex plugin marketplace add NerdOutInc/recall-plugins \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugins/recall
codex plugin add recall@recall
```

Older Codex versions that do not yet include `codex plugin` can use the
community marketplace helper:

```bash
npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall --plugin --global
```

For the helper only, swap `--global` for `--project` to scope the plugin to
the current repository.

## Claude Code Plugins

The same plugins work in Claude Code. Add this repository as a plugin
marketplace, then install the plugin:

```text
/plugin marketplace add NerdOutInc/recall-plugins
/plugin install recall@recall
```

Or from the command line (user scope makes the plugin available in every
project, which fits this plugin since it talks to the per-user Mac app):

```bash
claude plugin marketplace add NerdOutInc/recall-plugins
claude plugin install recall@recall --scope user
```

## Moving an existing install to Recall

The marketplace, plugin, MCP server, skills, journal config, and OAuth cache
now use Recall identifiers. Existing installations are not upgraded across
those identity changes automatically: add the Recall marketplace, install
**Recall**, start a new thread, and approve the browser sign-in once for
each host. Invoke `$recall:recall-journal` once if you use journaling so the
agent can configure this filesystem project or a global default, then select a
Recall workspace and optional Recall Project in `recall-journal.json`.

After the new Recall plugin works and its browser sign-in succeeds, retire the
legacy plugin so its hooks and MCP connection do not run alongside Recall:

```bash
claude plugin disable nerd-out-notes@nerd-out --scope user
codex plugin remove nerd-out-notes@nerd-out
```

Run only the command for the host you migrated. Recall's direct-download Mac
app performs this cleanup automatically, but only after it verifies the
replacement plugin. Sandboxed builds and manual installs use the steps above.

## Updating

Installed plugins do not update themselves by default. Both agents install
from a snapshot of this repository taken at install time, so run the steps
below whenever you want the latest release.

The commands below refer to the marketplace as `recall`. That is the
marketplace name from this repository's manifests, not the GitHub repository
name, and both agents register it when you add the marketplace. If you are
unsure what name your agent uses, run `codex plugin marketplace list` or
`/plugin marketplace list`.

### Codex

If you installed through the Codex app or the `codex` CLI, upgrade the
marketplace. This refreshes the snapshot and reinstalls the marketplace's
installed plugins at the new version:

```bash
codex plugin marketplace upgrade recall
```

The Codex app can do the same from **Plugins**: select the **Recall**
marketplace and choose its upgrade action.

If you installed with `codex-marketplace`, there is no update command; re-run
the install command to copy the latest files over the previous install:

```bash
npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall --plugin --global
```

### Claude Code

Refresh the marketplace listing, then update the plugin:

```text
/plugin marketplace update recall
/plugin update recall@recall
```

Or from the command line:

```bash
claude plugin marketplace update recall
claude plugin update recall@recall
```

Claude Code can also keep the plugin current automatically. Third-party
marketplaces have auto-update disabled by default, so opt in once: run
`/plugin`, open the **Marketplaces** tab, select **recall**, and choose
**Enable auto-update**. Updates are fetched in the background after a session
starts and take effect on the next launch or after `/reload-plugins`.

## Recall

`plugins/recall` connects Codex or Claude Code to the local MCP server
hosted by the Recall Mac app. The plugin does not run a notes server
itself; it points the agent at the loopback endpoint already managed by the
signed-in Mac app.

To use it:

1. Open Recall for Mac.
2. Go to Settings -> MCP Server.
3. Enable the local MCP server.
4. Start a new thread. The bridge opens a browser for Recall sign-in and
   consent the first time that host connects, unless a compatible Direct Recall
   build already connected this exact host through its in-app consent flow.

No explicit login command is needed. If the server does not appear, run
`codex mcp list` or `claude mcp list` to inspect the registered name. Claude
Code plugin servers are namespaced, so it normally appears as
`plugin:recall:recall`.

Current plugin versions register useful OAuth client names: **Codex** for the
Codex plugin, **Claude** for the shared Claude plugin, and **Claude Desktop**
for the standalone desktop extension. Their credentials are cached separately,
so each can be revoked independently. Rows named **MCP CLI Proxy** came from
older plugin versions and cannot be assigned back to a host reliably; after
the named registrations work, revoke those legacy rows in Recall.

Older app builds without OAuth support can still use the shared bearer token —
see the legacy setup section in the
[plugin README](plugins/recall/README.md).

Start a new thread after installing and authorizing so the plugin tools are
loaded.

Write tools appear when at least one confirmed workspace is set to
**Read & write** in Recall's MCP Server settings. A workspace omitted from the
policy remains blocked.

The plugin supports multiple skills in its `skills/` directory. In addition to
the direct note workflow, the journal skill
(`$recall:recall-journal` in Codex,
`/recall:recall-journal` in Claude Code) configures a per-agent
`recall-journal.json` with a global destination and/or absolute-path filesystem
project destinations. Each selects a Recall workspace and optional Recall
Project. A bundled per-prompt hook detects that valid opt-in config, reminds
the agent to search prior journal notes for
relevant context when a task relates to earlier work, and reminds it to
journal meaningful work live in that write-ready workspace: open a
marker-identified entry when substantive work begins, append short progress
updates at checkpoints, and close with a final block plus one tiny ELI5 Today
card linked to the detail (or an explicitly configured legacy DailyNote/none)
— so an interrupted session leaves a partial record instead of nothing.
Asking the agent to reconfigure the current filesystem
project updates only its destination in the same config, so sessions working
anywhere inside that project's folder — including Codex- or Claude-managed
linked worktrees stored elsewhere on disk — journal to the project's own
workspace and optional Recall Project instead of the global destination.

After installing or updating the plugin, start a new thread so its skills,
tools, and hook are loaded. Codex requires a one-time review and trust decision
for the plugin hook. The first explicit `$recall:recall-journal` invocation
checks the active Codex hook inventory and asks the user to open `/hooks` when
the Recall handler is new, modified, disabled, or missing. The skill never
changes or bypasses hook trust; Claude Code skips this Codex-only preflight
because it has no separate per-hook trust switch. The hook reads the per-agent
journal config, asks local Git for worktree metadata when available, and adds
agent context; the journal skill still validates the live workspace and
performs every note write through the Recall MCP server.
