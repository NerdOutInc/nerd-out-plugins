# Install Recall manually for Cursor, Claude Code, or Codex

Recall for Mac and Recall for Windows can start every supported setup from
**Settings → Integrations**. That is the preferred route. It installs Claude
Code and Codex directly; Cursor remains a guided install because Cursor owns
its plugin UI. Use this guide when you have the sandboxed App Store build,
want a terminal workflow, or need to maintain an older setup.

These commands still work with the current Claude Code and Codex plugin CLIs.
After installing, open Recall and enable **Settings → MCP Server**. Choose
**Block**, **Read**, or **Write** for each workspace before starting a new
agent thread.

## Windows notes

The plugin's MCP bridge launches through `node`, so **Node.js 18 or newer
must be on `PATH`**. The Claude Code commands below work unchanged in
PowerShell or cmd. For Cursor, replace the `ln -s` example with a directory
junction (`mklink /J "%USERPROFILE%\.cursor\plugins\local\recall"
C:\path\to\recall-plugins\plugins\recall`) or simply copy the
`plugins\recall` folder there. The Windows `codex` CLI does not yet expose
plugin management, so Codex installs are not available on Windows. With no
signed local-socket helper on Windows, the first connection opens a browser
sign-in (the OAuth path) instead of Recall's native approval prompt.

## Cursor

After Recall is published in Cursor's reviewed marketplace, open **Customize →
Plugins**, find **Recall**, and choose **Install** with user or project scope.
Until then, use Cursor's documented local-development path: clone this
repository, create `~/.cursor/plugins/local` if needed, and symlink the
`plugins/recall` directory as `~/.cursor/plugins/local/recall`. Restart Cursor
or run **Developer: Reload Window**. For example:

```bash
mkdir -p "$HOME/.cursor/plugins/local"
ln -s /absolute/path/to/recall-plugins/plugins/recall "$HOME/.cursor/plugins/local/recall"
```

Cursor's public CLI does not currently expose a supported plugin-install
command. Do not copy Claude's installed plugin or edit Cursor's private cache
by hand.

The Cursor package has its own `.cursor-plugin` manifest, MCP registration,
`sessionStart` journal hook, and `~/.cursor/recall-journal.json`. Start a
new Cursor chat after installation so those capabilities load.

## Codex

### Install from the Codex app

Open **Plugins**, choose **Create → Add plugin marketplace**, and enter:

- Source: `https://github.com/NerdOutInc/recall-plugins`
- Git ref: `main`
- Sparse paths: leave blank to load the whole marketplace, or enter both paths
  below on separate lines:

```text
.agents/plugins
plugins/recall
```

The marketplace manifest and plugin directory must both be present in a sparse
checkout. Add the marketplace, then install **Recall** from it.

### Install from the command line

This user-level install is available in every project:

```bash
codex plugin marketplace add NerdOutInc/recall-plugins \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugins/recall
codex plugin add recall@recall
```

Older Codex versions without `codex plugin` can use the community marketplace
helper:

```bash
npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall --plugin --global
```

Change `--global` to `--project` to install the helper only for the current
repository.

## Claude Code

From an interactive Claude Code session, add the marketplace and plugin:

```text
/plugin marketplace add NerdOutInc/recall-plugins
/plugin install recall@recall
```

The equivalent user-level command-line install is:

```bash
claude plugin marketplace add NerdOutInc/recall-plugins
claude plugin install recall@recall --scope user
```

## Approve the first connection

Start a new thread after installation. The current plugin uses the signed
local bridge included with Recall for Mac. Bring Recall to the front and
approve the host-named native prompt the first time each agent connects.
Cursor, Claude Code, and Codex receive independent grants; revoking one ends
only that host's sessions under **Settings → MCP Server → Local bridge
access**.

Older Recall builds use browser OAuth instead. Complete the browser approval
once for each host. In either case, the workspace policy in Recall remains the
final access check.

If the plugin does not appear, inspect Cursor's **Customize → Plugins** details
or the registered MCP servers with `codex mcp list` or `claude mcp list`.
Claude Code namespaces plugin servers, so Recall normally appears there as
`plugin:recall:recall`.

## Move from the old Nerd Out plugin

Older installs used `nerd-out-notes@nerd-out`. Install and verify the Recall
plugin first. If you use the journal, invoke `$recall:recall-journal` in Codex
or `/recall:recall-journal` in Claude Code to choose a workspace and optional
Recall Project.

After the replacement works, disable or remove the old plugin so two hooks and
MCP connections do not run together:

```bash
claude plugin disable nerd-out-notes@nerd-out --scope user
codex plugin remove nerd-out-notes@nerd-out
```

Run only the command for the host you migrated. The direct-download Mac app
performs this cleanup after it verifies the replacement. Manual installs and
sandboxed builds leave it to you. Very polite of them, if slightly lazy.

## Update a manual install

All three hosts install from a marketplace snapshot. The marketplace name is
`recall`, as declared by this repository's manifests.

For a published Cursor install, refresh or update Recall from **Customize →
Plugins**. For the local-development symlink, update the source checkout and
run **Developer: Reload Window**. Start a new chat after the update.

For Codex, refresh the marketplace snapshot and its installed plugins:

```bash
codex plugin marketplace upgrade recall
```

If you used `codex-marketplace`, rerun its install command instead; the helper
does not have a separate update command.

For Claude Code, refresh the marketplace and then the plugin:

```text
/plugin marketplace update recall
/plugin update recall@recall
```

The command-line equivalents are:

```bash
claude plugin marketplace update recall
claude plugin update recall@recall
```

Claude Code can also update this third-party marketplace automatically. Run
`/plugin`, open **Marketplaces**, select **recall**, and enable auto-update.
The new plugin version loads on the next launch or after `/reload-plugins`.
