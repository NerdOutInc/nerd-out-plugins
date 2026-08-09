---
name: recall
description: Use Recall's local MCP server to list, read, search, and optionally update the signed-in user's notes.
---

# Recall

Use this skill when the user asks the agent to work with their notes in Recall
through the local MCP server.

## Setup Checks

- The Recall Mac app must be running.
- Settings -> MCP Server must be enabled in the app.
- The agent must be authorized with the server:
  - **Codex:** start a new thread after installation. The bridge opens a
    browser for Recall sign-in and consent on first connection. Use
    `codex mcp list` to inspect the registered name if the server is absent.
  - **Claude Code:** start a new conversation after installation and complete
    the browser sign-in on first connection. Plugin servers are namespaced, so
    the server appears as `plugin:recall:recall`; use
    `claude mcp list` to inspect the exact name.
  - Legacy setups on older app builds may use the `NERD_OUT_MCP_TOKEN` bearer
    token instead.
- The server endpoint is `http://127.0.0.1:38473/mcp`.

If the Recall server never appears in the tool list, or MCP calls
fail with connection errors (unable to connect, server unreachable), the
Recall Mac app is not running — or its MCP server is disabled in
Settings.
Verify with `nc -z 127.0.0.1 38473`. A locked screen does NOT cause this: the
app keeps serving MCP while the Mac is locked and while its windows are
closed, so never report lock, sleep, or screen state as the cause. Ask the
user to launch the Recall Mac app (it is often quit during
development, since dev builds share port 38473) and enable the local MCP
server. If calls fail with authorization errors, ask the user to
start a new conversation so the bridge re-runs the browser sign-in (access may
have been revoked or expired).
On legacy token setups, ask the user to reveal or regenerate the token in
Recall settings and update `NERD_OUT_MCP_TOKEN`.

## Tool Use

- Use `list_notes` before reading when the user gives a title, date, tag, or
  broad description instead of a note UUID.
- Use `read_note` for exact note content. Request `format: "html"` or
  `format: "both"` only when the user needs editor-fragment HTML; plain text is
  the default.
- Use `keyword_search` for exact terms, names, tags, or phrases.
- Use `semantic_search` for meaning-based discovery, and fall back to keyword
  search if semantic search is unavailable.
- Use `get_index_status` when search readiness is unclear.
- Use `list_projects` with an explicit `workspaceId` to discover the live Recall
  Projects in that workspace. A `projectId` filter on list or search also
  requires that `workspaceId`; Project-filtered note results exclude DailyNotes.
- Use `list_note_collaborators` only for shared named notes.

## Links in chat

When linking to a Recall note in a user-facing chat response, use a Markdown
link whose complete URL starts with `https://recall.nerdout.com`. Never expose
a relative `/notes/...` path as the chat destination. Prefer the MCP result's
absolute `href`; if a result is relative, resolve it against
`https://recall.nerdout.com` before presenting it.

## Writes

Write tools are advertised only when at least one workspace is set to Write in
the app's Settings -> MCP Server per-workspace access policy.

- Use `create_note` for new named notes. To file one in a Recall Project, pass
  both the selected `workspaceId` and a `projectId` returned by `list_projects`;
  never guess an id or silently retry without it after a Project-target error.
- Use `create_today_note` for one short Today timeline summary when the caller
  has an explicit writable `workspaceId` and a stable retry key. Keep the title
  and body plain and tiny, pass the same-workspace `projectId` when needed, and
  use real `backlinks` to connect the card to a detailed note. Repeating the
  identical `idempotencyKey` request returns the original card; a changed
  request fails closed.
- Use `update_note_content` with `mode: "append"` when adding a journal entry,
  update, or note section.
- Use `update_note_content` with `mode: "replace"` only when the user explicitly
  wants to replace the whole note body.
- The server has retired DailyNote creation: `update_note_content` against a
  missing DailyNote fails with "Note not found. Daily Notes can no longer be
  created; use placement=today when creating a note." Use `create_today_note`
  for new day-level notes; existing DailyNotes remain readable.

Never invent note content that should come from the user's notes. Read or search
first, then make the smallest write that satisfies the request.
