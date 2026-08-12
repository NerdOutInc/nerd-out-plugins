# Recall — Claude Desktop Extension

A Claude Desktop extension (`.mcpb` bundle) that connects Claude Desktop to
the local MCP server hosted by Recall for Mac.

This is the fallback install path for Claude Desktop chat. The
[Claude plugin](../../plugins/recall) is the primary path — it bundles
the same stdio bridge plus the skills — but its bridge runs on the Node.js
found on your PATH. This extension instead runs on **Claude Desktop's built-in
Node runtime**, so it works on Macs with no Node install at all, and installs
by double-clicking one file.

## Install (end users)

1. Download `recall.mcpb` from the latest release.
2. Double-click the file, or in Claude Desktop open **Settings ->
   Extensions -> Advanced settings -> Install Extension…** and pick it.
3. Open Recall for Mac and enable **Settings -> MCP Server**.
4. The first time Claude connects, Recall shows a native prompt asking you to
   approve MCP access on this Mac. Approve it, then start a new conversation.
   (Against a Recall build older than the local bridge, a browser window opens
   for OAuth sign-in instead.)

If the extension shows an error because the Mac app wasn't running, open the
app and toggle the extension off/on in Claude Desktop settings (the bridge
also waits up to 60 seconds for the app on startup).

## How it works

```
Claude Desktop ── stdio ──> server/index.mjs ── execs ──> Recall.app's signed
                                                          recall-mcp-bridge
                                                            │ unix socket
                                                            ▼
                                                          Recall for Mac
```

- `server/index.mjs` looks for the Recall-signed helper at
  `Recall.app/Contents/Helpers/recall-mcp-bridge`. When it is present, the
  helper connects to a Unix socket in Recall's app-group container and MCP
  stdio is pumped straight through.
- Recall authenticates the connecting *process*: it reads the peer's audit
  token and checks the helper's code signature (Team ID + signing identifier)
  before answering, then applies your one-time approval for the signed-in
  account. There are no tokens on disk and no browser round-trip.
- The transport each session used is named in the log
  (`[recall] transport: local-socket` or `transport: oauth-http`).

Fallback (older Recall builds, or no protocol overlap):

```
Claude Desktop ── stdio ──> server/index.mjs ── spawns ──> bundled mcp-remote ── HTTP ──> http://127.0.0.1:38473/mcp
```

- The bundled single-file `mcp-remote`
  (`server/mcp-remote-proxy.bundle.mjs`, MIT — `server/LICENSE-mcp-remote.txt`)
  runs with `--transport http-only` and the OAuth client name
  **Claude Desktop**.
- `mcp-remote` handles MCP OAuth: it discovers the authorization server
  (`https://recall.nerdout.com`), registers a client, opens the
  browser for sign-in, and caches/refreshes tokens under
  `~/.mcp-auth/recall/claude-desktop`.
- The access token's audience is the loopback URL, matching the Mac app's
  token verification, and note content only ever moves over the loopback
  interface.
- A denial, revocation, signature failure, or pending approval on the socket
  path is reported as an error and never silently downgraded to OAuth.

The bridge files are copies of `plugins/recall/bridge/` — regenerate
the bundle there (`bridge/build/`) and re-copy when upgrading mcp-remote.

## Build

```bash
cd desktop-extensions/recall
npx @anthropic-ai/mcpb pack . recall.mcpb
```

The `.mcpb` artifact is not committed; attach it to a GitHub release.

## Troubleshooting

- **"Recall doesn't appear to be running"** in the extension logs:
  open the Mac app and enable Settings -> MCP Server, then toggle the
  extension.
- **"Open Recall to approve"**: the approval prompt is waiting in Recall (it
  never steals focus). Bring Recall to the front and approve.
- **Access denied or revoked**: Recall remembers the decision so a restarting
  agent cannot re-prompt in a loop. Clear it with **Allow again** under
  Settings → MCP Server → Local bridge access.
- **Sign-in errors on the OAuth fallback**: access may have been revoked or
  expired. Toggle the extension to re-trigger the browser sign-in. If it loops,
  delete `~/.mcp-auth/recall/claude-desktop` and try again.
- **Still listed as MCP CLI Proxy**: that is an older registration whose
  original host cannot be identified safely. Once **Claude Desktop** is
  authorized and working, revoke the legacy row in Recall.
- **Which Claude surface is this for?** Claude Desktop chat only. Claude Code
  and Cowork users should install the
  [Claude plugin](../../plugins/recall) instead.
