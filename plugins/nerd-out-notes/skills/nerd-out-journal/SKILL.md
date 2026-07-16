---
name: nerd-out-journal
description: Keep a concise, searchable journal of agent work in NerdOut. Use when the user invokes the nerd-out-journal skill ($nerd-out-notes:nerd-out-journal in Codex, /nerd-out-notes:nerd-out-journal in Claude Code) or when plugin lifecycle context reports a valid global nerd-out-journal.json configuration for the current agent; once configured, journal every task with useful decisions, implementation work, tests, or follow-ups. Configure a workspace on first use, write a daily summary, choose an appropriate set of detailed named notes, and search the archive before repeating past decisions.
---

# NerdOut Journal

Use NerdOut as a global scratchpad for decisions and task history. The journal
is deliberately summary-first: save the useful context, not a surprise
transcript dump.

## Activation and configuration

Resolve the agent's global configuration directory. Each agent keeps its own
configuration; use only the directory for the agent you are running in:

- **Codex:** `$CODEX_HOME`, falling back to `~/.codex`.
- **Claude Code:** `$CLAUDE_CONFIG_DIR`, falling back to `~/.claude`.

Then look for:

```text
<config-dir>/nerd-out-journal.json
```

The expected shape is:

```json
{
  "version": 1,
  "scope": "global",
  "workspace": {
    "id": "workspace-id",
    "name": "Workspace name"
  },
  "journal": {
    "dailyNote": true
  }
}
```

`journal.dailyNote` may be omitted; omission defaults to `true`.

When the file is missing, malformed, or the saved workspace is no longer
available, call `list_workspaces` and show the user only confirmed,
write-ready choices. Include each workspace's name, id, role, and write status.
Ask the user to choose by name or id; do not silently choose a workspace or
overwrite a stale selection. After an explicit choice, create the resolved
configuration directory when needed and save the file above. When the agent's
config-directory environment variable is unset, that resolved directory is the
agent's home-directory fallback listed above. Keep the file local to the
machine and do not put tokens, note bodies, or credentials in it. Do not read
or migrate another agent's configuration file; each agent is configured
independently.

Only offer workspaces that are confirmed and not blocked, with both
`roleWritable` and `writeReady` set to true. This skill is write-ready-only: do
not bind to, search as a journal in, or write to a read-only, blocked,
non-confirmed, or not-ready workspace.

When the skill is invoked explicitly, configure the workspace if necessary and
then journal the current task. When the valid global configuration already
exists, invoke this skill implicitly for every task going forward, including
tasks where the user did not mention journaling. Validate the saved workspace
with `list_workspaces` before writing; if it is no longer write-ready, pause
the journal write and ask the user to select a replacement rather than
silently switching.

The plugin's `UserPromptSubmit` hook checks only whether this agent's config
exists and has the expected shape, then adds lifecycle context telling the
agent to load this skill for meaningful work. The hook does not validate the
workspace or write notes itself. Always perform the live workspace validation
above after implicit activation.

If `journal.dailyNote` is `true` or omitted, perform the DailyNote update in
addition to the named-note work. If it is `false`, still journal the task in the
selected named notes but skip the DailyNote update.

Distinguish explicit from implicit activation. An explicit skill invocation
(`$nerd-out-notes:nerd-out-journal` in Codex,
`/nerd-out-notes:nerd-out-journal` in Claude Code) may prompt for a workspace
when the config is missing or invalid. An implicit invocation with no valid
config must skip journaling for that task without prompting or interrupting
unrelated work; wait for the user to invoke the skill explicitly before
starting setup.

## Search before writing

Before making a decision that may already have been recorded, search the saved
workspace with `keyword_search` and, when available, `semantic_search`. Use
specific terms from the task, relevant file names, and subsystem names. Read
promising results with `read_note` and treat them as context, not authority:
verify important claims against the current checkout.

Always pass the configured `workspaceId` to `list_notes`, `keyword_search`,
`semantic_search`, and `create_note`. `update_note_content` targets the note's
own workspace and must never be used to move a note between workspaces.

## Per-task journal workflow

At the end of meaningful work, do the following in order:

1. Decide how many named notes are useful and how they should be organized.
   Reuse, split, merge, or create notes based on what will make future search
   and retrieval clearest; there is no fixed one-note-per-task rule. If a
   matching note exists, read it and append or revise it instead of creating
   needless duplicates.
2. Decide what information is worth preserving for a future agent. Capture
   durable context such as objectives, decisions and rejected alternatives,
   important files or paths, commands and tests run, outcomes, blockers, and
   next steps when they improve future search and reasoning. Keep secrets,
   access tokens, private user data, and raw tool output out of the note unless
   the user explicitly requests them.
3. Update the current day's DailyNote with a short dated summary. Include the
   task title, outcome, decisions, tests, and follow-ups. Add a backlink to the
   detailed named note so the daily page is an index into the archive.
4. Make writes idempotent. Before appending, read the target note and avoid
   repeating an entry with the same task marker and date. If a write fails,
   report the failure and do not claim that the journal was updated.

The following shapes are suggestions, not a required schema; adapt them to the
task and the archive:

```text
## YYYY-MM-DD — <task title>

Objective: <what we set out to do>
Outcome: <what changed or was learned>

Decisions:
- <decision and why>

Evidence:
- Files: <paths>
- Commands/tests: <commands and results>

Follow-ups:
- <next step, blocker, or none>
```

Use this daily-note template, where `<agent>` is the agent's name ("Codex" or
"Claude Code"):

```text
## <agent> — <task title>

<one or two sentence summary>
Decisions: <short list or none>
Tests: <short result or none>
Follow-ups: <short list or none>
```

When updating a DailyNote, send the detailed named note as a backlink in the
`backlinks` field rather than pasting a fake Markdown URL. Preserve existing
daily content by using `mode: "append"`. For the configured workspace, use the
current date as the DailyNote identifier
`date=YYYY-MM-DD&workspaceId=<configured-workspace-id>`; the journal MCP lazily
materializes a missing DailyNote from that identifier. If that
write is rejected by workspace readiness or encryption state, save the named
note but report that the daily summary did not succeed.

## Read and maintenance operations

- Use `list_notes` for a lightweight archive index and to locate today's
  DailyNote or prior named notes.
- Use `read_note` for full text or HTML when a note's details matter.
- Use `keyword_search` for exact terms, paths, and identifiers; use
  `semantic_search` for concepts and paraphrases.
- Use `update_note_content` with `mode: "append"` for new dated entries and
  `mode: "replace"` only when the user explicitly asks to rewrite a note.
- Keep summaries short enough to scan. The named note is the durable detail;
  the daily note is the day's navigation page.

## Failure and safety rules

- Never select a workspace silently, especially after a workspace id changes.
- Never bind, search, or write through the journal in a workspace that is
  blocked, non-confirmed, non-writable, or not write-ready.
- Never treat a failed MCP response as a successful journal write.
- Never put credentials or entire conversation transcripts in the journal by
  default.
- If the user asks to stop journaling, stop writing for the task and leave the
  configuration file unchanged.
