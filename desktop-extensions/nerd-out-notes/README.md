# Nerd Out Notes — Claude Desktop Extension

A Claude Desktop extension (`.mcpb` bundle) that connects Claude Desktop to
the local MCP server hosted by Nerd Out Notes for Mac.

This is the fallback install path for Claude Desktop chat. The
[Claude plugin](../../plugins/nerd-out-notes) is the primary path — it bundles
the same stdio bridge plus the skills — but its bridge runs on the Node.js
found on your PATH. This extension instead runs on **Claude Desktop's built-in
Node runtime**, so it works on Macs with no Node install at all, and installs
by double-clicking one file.

## Install (end users)

1. Download `nerd-out-notes.mcpb` from the latest release.
2. Double-click the file, or in Claude Desktop open **Settings ->
   Extensions -> Advanced settings -> Install Extension…** and pick it.
3. Open Nerd Out Notes for Mac and enable **Settings -> MCP Server**.
4. The first time Claude connects, a browser window opens to sign in to your
   Nerd Out account and approve access. Approve, then start a new
   conversation.

If the extension shows an error because the Mac app wasn't running, open the
app and toggle the extension off/on in Claude Desktop settings (the bridge
also waits up to 60 seconds for the app on startup).

## How it works

```
Claude Desktop ── stdio ──> server/index.mjs ── spawns ──> bundled mcp-remote ── HTTP ──> http://127.0.0.1:38473/mcp
```

- `server/index.mjs` waits for the Mac app's loopback server to be reachable,
  then runs the bundled single-file `mcp-remote`
  (`server/mcp-remote-proxy.bundle.mjs`, MIT — `server/LICENSE-mcp-remote.txt`)
  with `--transport http-only` and the OAuth client name
  **Claude Desktop**.
- `mcp-remote` handles MCP OAuth: it discovers the authorization server
  (`https://nerd-out-notes.vercel.app`), registers a client, opens the
  browser for sign-in, and caches/refreshes tokens under
  `~/.mcp-auth/nerd-out-notes/claude-desktop`.
- The access token's audience is the loopback URL, matching the Mac app's
  token verification, and note content only ever moves over the loopback
  interface.

The bridge files are copies of `plugins/nerd-out-notes/bridge/` — regenerate
the bundle there (`bridge/build/`) and re-copy when upgrading mcp-remote.

## Build

```bash
cd desktop-extensions/nerd-out-notes
npx @anthropic-ai/mcpb pack . nerd-out-notes.mcpb
```

The `.mcpb` artifact is not committed; attach it to a GitHub release.

## Troubleshooting

- **"Nerd Out Notes doesn't appear to be running"** in the extension logs:
  open the Mac app and enable Settings -> MCP Server, then toggle the
  extension.
- **Sign-in errors**: access may have been revoked or expired. Toggle the
  extension to re-trigger the browser sign-in. If it loops, delete
  `~/.mcp-auth/nerd-out-notes/claude-desktop` and try again.
- **Still listed as MCP CLI Proxy**: that is an older registration whose
  original host cannot be identified safely. Once **Claude Desktop** is
  authorized and working, revoke the legacy row in Nerd Out.
- **Which Claude surface is this for?** Claude Desktop chat only. Claude Code
  and Cowork users should install the
  [Claude plugin](../../plugins/nerd-out-notes) instead.
