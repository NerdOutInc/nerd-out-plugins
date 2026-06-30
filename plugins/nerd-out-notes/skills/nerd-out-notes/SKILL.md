---
name: nerd-out-notes
description: Use the Nerd Out Notes local MCP server to list, read, search, and optionally update the signed-in user's notes from Codex.
---

# Nerd Out Notes

Use this skill when the user asks Codex to work with their Nerd Out Notes data
through the local MCP server.

## Setup Checks

- The Nerd Out Notes Mac app must be running.
- Settings -> MCP Server must be enabled in the app.
- Codex must have `NERD_OUT_MCP_TOKEN` set to the token revealed in Nerd Out
  Notes settings.
- The server endpoint is `http://127.0.0.1:38473/mcp`.

If MCP calls fail with connection errors, ask the user to open Nerd Out Notes
for Mac and enable the local MCP server. If calls fail with authorization
errors, ask the user to reveal or regenerate the token in Nerd Out Notes
settings and update `NERD_OUT_MCP_TOKEN`.

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
- Use `list_note_collaborators` only for shared named notes.

## Writes

Write tools are available only when the user enables "Allow writes" in Nerd Out
Notes settings.

- Use `create_note` for new named notes.
- Use `update_note_content` with `mode: "append"` when adding a journal entry,
  update, or note section.
- Use `update_note_content` with `mode: "replace"` only when the user explicitly
  wants to replace the whole note body.

Never invent note content that should come from the user's notes. Read or search
first, then make the smallest write that satisfies the request.
