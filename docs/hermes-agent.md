# Connect Hermes Agent to Recall

Hermes Agent can use Recall's notes tools through the local MCP server hosted
by Recall for Mac. Hermes connects directly over HTTP and authenticates with
OAuth 2.1; it does not need the Recall plugin used by Codex and Claude.

## Requirements

- Run Hermes Agent on the same Mac as Recall. Recall listens only on
  `127.0.0.1`, so a Hermes gateway running on another computer cannot reach it.
- Install a current Hermes Agent release. MCP support is included in the
  standard install; run `hermes update` if an older release does not recognize
  the `hermes mcp` commands.
- Open Recall for Mac, sign in, and enable **Settings → MCP Server**.
- In the same Recall settings pane, choose **Block**, **Read**, or **Write**
  for each workspace. An unconfigured workspace remains
  blocked.

OAuth is the supported path for third-party MCP clients such as Hermes. The
Recall-signed local bridge used by the Recall Codex and Claude plugins is a
first-party integration and is not needed here. One fewer bridge, one fewer
tiny troll guarding a config file.

## 1. Add Recall to Hermes

Open Hermes's configuration:

```bash
hermes config edit
```

Merge the following entry into `~/.hermes/config.yaml`. If the file already
has an `mcp_servers` section, add `recall` beneath it rather than creating a
second section.

```yaml
mcp_servers:
  recall:
    url: "http://127.0.0.1:38473/mcp"
    auth: oauth
    oauth:
      client_name: "Hermes Agent"
      scope: "notes:read notes:write"
```

The key is `mcp_servers`, with an underscore. The similarly shaped
`mcpServers` key used by some other MCP clients will not work in Hermes.

The example requests both Recall scopes:

- `notes:read` permits listing, reading, and searching notes.
- `notes:write` permits creating, updating, and renaming notes when the target
  workspace is also set to **Write** in Recall.

For a read-only connection, use this instead:

```yaml
      scope: "notes:read"
```

Newer Recall builds also advertise `journal:read` and `journal:write` for the
Project coordination tools (structured Project context, agent work sessions,
typed timeline entries, handoffs, directed asks, and collaboration comment
threads). Add them to `scope` only when you want Hermes to use that surface;
each tool enforces its own exact scope set (`get_project_context` needs both
`notes:read` and `journal:read`), and an existing grant never widens on its
own — rerun `hermes mcp login recall` after changing the scope line.

Recall's per-workspace policy remains the final gate. Granting
`notes:write` or `journal:write` in OAuth does not override a workspace set to
**Read** or **Block**.

## 2. Install the Recall skill

The MCP connection gives Hermes access to Recall's tools. The Recall skill
adds the instructions Hermes needs to choose those tools, preserve note
structure, handle permissions, and avoid unsafe writes.

Inspect the skill before installing it, then install it directly from this
repository:

```bash
hermes skills inspect https://raw.githubusercontent.com/NerdOutInc/recall-plugins/main/plugins/recall/skills/recall/SKILL.md
hermes skills install https://raw.githubusercontent.com/NerdOutInc/recall-plugins/main/plugins/recall/skills/recall/SKILL.md
hermes skills list
```

Hermes records the source URL, so a later `hermes skills update` refreshes the
installed copy. Start a new Hermes session after installation. The skill is
available automatically and can also be invoked explicitly as `/recall`.

Only install the base `recall` skill in Hermes for now. The separate
`recall-journal` skill depends on Claude Code and Codex lifecycle hooks and is
not currently packaged for Hermes.

## 3. Authorize Hermes

Run the login from a fresh terminal:

```bash
hermes mcp login recall
```

Hermes opens Recall's authorization page in the browser and waits for a local
callback. Sign in with the same account used by Recall for Mac, review the
requested scopes, and approve the client named **Hermes Agent**. Keep the
terminal open until Hermes reports that authentication completed.

Hermes stores the resulting OAuth credentials under
`~/.hermes/mcp-tokens/` with user-only file permissions and refreshes them on
later connections.

## 4. Verify the connection

Confirm the server is registered and that Hermes can discover its tools:

```bash
hermes mcp list
hermes mcp test recall
```

Then start a new chat:

```bash
hermes chat
```

Try a read-only smoke test first, explicitly invoking the installed skill:

```text
/recall List my workspaces, then show me the five newest notes I can read.
```

Hermes prefixes discovered tools with the server name, such as
`mcp_recall_list_workspaces` and `mcp_recall_list_notes`, but normal prompts do
not need to name those functions explicitly.

With at least one **Write** workspace and both OAuth scopes, Recall also
advertises `create_note`, `create_today_note`, `update_note_content`, and
`rename_note`. Start with a harmless test note before giving Hermes the keys to
the literary kingdom.

## Troubleshooting

### Connection refused or server unreachable

Confirm Recall for Mac is open and its MCP server is enabled:

```bash
nc -z 127.0.0.1 38473
```

A successful check reports that the TCP connection succeeded. If Hermes runs
on a remote host, container, or VPS, move Hermes to the Mac running Recall;
Hermes's remote OAuth callback workarounds do not make Recall's loopback-only
MCP listener remotely reachable. Do not expose the listener to the network.

### OAuth login fails or access was revoked

Run the login command again:

```bash
hermes mcp login recall
```

This clears Hermes's cached OAuth state for the `recall` server and starts a
fresh authorization. You can also revoke the old **Hermes Agent** grant in
Recall under **Settings → MCP Server → Authorized clients**, then log in again.

If a browser cannot deliver the loopback callback, use the paste-back option
Hermes prints in the terminal: approve the request, copy the complete final
redirect URL from the browser, and paste it at the prompt.

### Read tools work but write tools do not

Check both independent gates:

1. `oauth.scope` includes `notes:write`; after changing it, run
   `hermes mcp login recall` so the new grant receives that scope.
2. At least one Recall workspace is set to **Write** under
   **Settings → MCP Server**.

### Tools do not appear after editing the config

Start a new Hermes session or run `/reload-mcp` inside the current session.
For the initial browser authorization, prefer `hermes mcp login recall` in a
fresh terminal; an automatic reload can time out while waiting for a person to
finish OAuth, which is a wonderfully human way for software to become
impatient.

## References

- [Hermes Agent MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Hermes Agent MCP configuration reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [Hermes Agent skills guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
