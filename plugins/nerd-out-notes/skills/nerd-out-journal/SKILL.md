---
name: nerd-out-journal
description: Keep a concise, searchable journal of agent work in NerdOut and read it back as the agent's long-term memory. Use when the user invokes the nerd-out-journal skill ($nerd-out-notes:nerd-out-journal in Codex, /nerd-out-notes:nerd-out-journal in Claude Code) or when plugin lifecycle context reports a valid global nerd-out-journal.json configuration for the current agent; once configured, search the journal at the start of tasks that may relate to prior work and journal every task with useful decisions, implementation work, tests, or follow-ups — live, as the work happens, not only at the end. Configure a workspace on first use, bind a project to its own workspace when the user asks, recall and cite relevant prior notes before deciding, open the task's entry under a unique task marker when substantive work begins, append progress at checkpoints, write a daily summary, and choose an appropriate set of detailed named notes.
---

# NerdOut Journal

Use NerdOut as a global scratchpad for decisions and task history. The journal
is deliberately summary-first: save the useful context, not a surprise
transcript dump. It is also two-way: a journal that is written but never read
back is dead weight, so recall from the archive at the start of related work
is as much a part of this skill as writing at the end. It is also live: an
entry opens when substantive work begins and grows at checkpoints, so an
interrupted session leaves a partial record instead of nothing.

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
  },
  "projects": {
    "/absolute/path/to/project": {
      "workspace": {
        "id": "project-workspace-id",
        "name": "Project workspace name"
      }
    }
  }
}
```

`journal.dailyNote` may be omitted; omission defaults to `true`. `projects`
may also be omitted; when present it maps absolute project-root paths — never
the filesystem root itself — to per-project workspace overrides (see
"Per-project workspaces" below).

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
tasks where the user did not mention journaling. Implicit activation covers
the whole task: recall relevant journal context before substantive work
(see "Recall before working" below), open the task's entry and append
progress while working (see "Journal as you go" below), and finalize the
entry at the end.
Validate the saved workspace with `list_workspaces` before writing; if it is
no longer write-ready, pause the journal write and ask the user to select a
replacement rather than silently switching.

The plugin's `UserPromptSubmit` hook checks only whether this agent's config
exists and has the expected shape, then adds lifecycle context that names the
effective workspace (see "Per-project workspaces" below), tells the agent to
search the journal when the task may relate to prior work, and tells it to
load this skill when meaningful work begins so the entry can be opened and
updated live. The hook does not validate the workspace
or write notes itself. Recall searches may target the effective workspace
directly, but always perform the live workspace validation above before
implicit writes.

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

## Per-project workspaces

The global workspace is the default journal for every session. A project can
also get its own journal: when the user explicitly asks to select a workspace
for the current project ("select a Nerd Out workspace for this project",
"journal this repo to its own workspace"), add a project binding to the same
per-agent config instead of changing the global selection.

To bind a project:

1. Resolve the project root. Agents identify a project by its folder path, so
   use the main checkout's top-level directory: in a git repository, the
   parent directory of `git rev-parse --path-format=absolute --git-common-dir`,
   which maps linked worktrees back to the main checkout; outside git, the
   session's working directory.
2. Offer workspaces under the same rules as the global selection: confirmed,
   write-ready choices only, chosen explicitly by name or id.
3. Show the user the resolved absolute path and the chosen workspace, and only
   after they confirm save the entry under `projects`, keyed by that path.
   Leave the global `workspace` unchanged; if the config file does not exist
   yet, run the global selection first so the file stays valid.

A saved project covers its root and everything inside it, including subfolders
and worktrees checked out under the repo (for example
`<repo>/.claude/worktrees/<name>`). The effective journal workspace for a
session is the entry with the longest saved root that equals or contains the
session's working directory, falling back to the global workspace when no
entry matches. The plugin hook performs the same resolution and names the
effective workspace in its lifecycle context.

Use the effective workspace for everything this skill does in the session:
recall searches, named notes, and the DailyNote all target the project
workspace when an override matches. Validation rules apply unchanged: if a
project's saved workspace is no longer write-ready, pause and ask the user to
update that project entry rather than silently falling back to the global
workspace. One exception helps recall: when a
project search finds nothing and the task clearly references older work, a
follow-up search of the global workspace may recover notes journaled before
the project was bound — but writes still go only to the effective workspace.

When the user asks to stop journaling a project separately, confirm which
entry and delete it so sessions fall back to the global workspace. Never add,
change, or remove a project binding implicitly; only explicit user requests
change the config file.

## Recall before working

The archive only pays for itself when it changes what happens next. At the
start of meaningful work, decide whether the journal could already cover part
of the task, and search before proceeding when it might: the task continues an
ongoing project, touches a subsystem this agent has likely worked on before,
revisits a decision or bug that may already be recorded, or leans on context
the user assumes is known ("like last time", "continue where we left off",
"the usual fix").

- Use `keyword_search` for exact terms: file names, paths, subsystem and
  project names, error strings, and identifiers from the task.
- Use `semantic_search`, when available, for concepts and paraphrases that
  exact terms would miss.
- Use `list_notes` or recent DailyNotes when the user points at time rather
  than topic ("what did we do yesterday?", "where did we leave off?").
- Read promising results with `read_note` and treat them as context, not
  authority: verify important claims against the current checkout before
  relying on them.

When a journal note shapes the work — a decision followed, a fix reused, a
pitfall avoided — say so in the response and name the note, so the user can
see what the journal contributed. When searches return nothing relevant, move
on without further reads: one or two focused searches are enough for most
tasks, and recall must never stall the task itself.

Recall also applies just before writing: when about to record a decision that
may already be journaled, search first and extend the existing note instead of
creating a duplicate.

Always pass the effective workspace's `workspaceId` (the project override
when one matches, the global workspace otherwise) to `list_notes`,
`keyword_search`, `semantic_search`, and `create_note`. `update_note_content`
targets the note's own workspace and must never be used to move a note
between workspaces. If recall searches fail because the effective workspace
is no longer available, continue the task without journal context and run the
workspace re-validation flow before any write; never silently search a
different workspace instead.

## Journal as you go

Journal entries are written live, not reconstructed after the fact. When
substantive work begins — after recall — open the task's entry; append
progress at checkpoints while working; finalize before the task's last
response. An interrupted session then leaves a partial entry ending at its
last checkpoint, and an entry whose marker has no final block is the visible
sign of an unfinished run.

### Task markers

Give every run one stable identity. After recall, either resume an existing
marker (rules below) or mint a fresh one: a kebab-case task slug, the date,
and at least 64 random bits — for example
`fix-sync-retries-2026-07-19-9f2ab41c77d03e58` from `openssl rand -hex 8`,
or a UUID in place of the hex suffix. Never reuse a marker across runs, and
never treat a title or date as task identity.

The marker is also how the run's writes are recognized later, so it appears
in the opening block, in every appended block, and in the DailyNote summary.

Search never establishes marker identity. `keyword_search` is fuzzy,
prefix-matching lexical search, so its results are only candidates. Whenever
a decision depends on locating a marker — resuming, recovering a lost note
uuid, deduplicating — read each candidate with `read_note` and keep only
notes whose body literally contains `Task marker: <marker>`. Count matches
after that literal filter, never from raw search hits: act on exactly one
literal match, and treat zero or several as "not found" or "ambiguous",
never as license to guess.

Resume a marker only when recall surfaces an unfinished entry for the same
work: an opening block whose marker has no matching final block, confirmed
by literal containment. Exactly one such match → continue that run, adopting
its marker (and, for a task-exclusive note, that note's uuid). A finished
same-title task, or an ambiguous set of unfinished candidates, always gets a
fresh marker; record the ambiguity in the new opening block instead of
guessing.

### Where the entry lives

Appends always land at the end of a note; nothing can be inserted beneath an
earlier heading. Two layouts respect that:

- **Task-exclusive note (default).** Create a named note for this run when
  the entry opens and keep its uuid for the whole session; every progress
  and final append targets that uuid, so the entry reads as one contiguous
  timeline.
- **Shared topic note.** When the task clearly continues an existing
  running-log note's thread, the entry may live there instead — but every
  append must then be a self-contained block that repeats the marker,
  because blocks from other tasks or concurrent sessions may land between
  this run's blocks. Never present a shared note's entry as contiguous.

### Entry lifecycle

Open with a heading, the marker, and the objective:

```text
## YYYY-MM-DD — <task title>

Task marker: <marker>
Objective: <what we set out to do>
```

At checkpoints, append a short progress block:

```text
### <marker> — progress

- <one-line update>
```

Checkpoints are judgment calls: a durable decision made, a significant step
completed, tests or builds run with their results, a blocker or change of
direction, or a long autonomous stretch that would otherwise leave the entry
stale. Never journal per tool call or per file edit; a handful of progress
blocks per task is typical.

Close with a final block:

```text
### <marker> — final

Outcome: <what changed or was learned>

Decisions:
- <decision and why>

Evidence:
- Files: <paths>
- Commands/tests: <commands and results>

Follow-ups:
- <next step, blocker, or none>
```

These block shapes are suggestions, not a required schema — adapt them to
the task and the archive — but keep the `Task marker: <marker>` line
literal; recovery and deduplication depend on it.

### Write-failure protocol

Any journal write that errors, times out, or loses its response may still
have landed. Recover by reading, never by blind retry, and never let
recovery stall the task itself:

- **Opening `create_note`:** the note may exist even though its uuid never
  arrived. Query the full marker with `keyword_search`, read each candidate,
  and keep only literal `Task marker: <marker>` matches. Exactly one →
  adopt that note's uuid and continue. Zero or several → the journal state
  is unknown: stop journal writes, continue the task, report the state at
  the end, and never create a replacement note.
- **Progress append:** stop further progress writes and keep working;
  before finalizing, read the note once and fold anything missing into the
  final block.
- **Final append:** read the note; if the final block already landed, the
  entry is closed. Append it again only after the readback confirms it is
  absent.
- **DailyNote append:** the summary embeds the marker, so read the DailyNote
  and append only when the marker is absent.
- If a recovery readback itself fails, report the journal state as unknown
  rather than claiming or guessing that any write landed.

## Finalizing a task

At the end of meaningful work, close the live entry:

1. Confirm where the durable record belongs. The note chosen when the entry
   opened is usually right; if the work surfaced a better home — an existing
   topic note found during the task, or one entry that should become two
   notes — write the final block accordingly and say so in it. Reuse, split,
   merge, or create notes based on what will make future search and
   retrieval clearest; there is no fixed one-note-per-task rule.
2. Decide what the final block preserves for a future agent. Capture durable
   context such as objectives, decisions and rejected alternatives,
   important files or paths, commands and tests run, outcomes, blockers, and
   next steps when they improve future search and reasoning. Keep secrets,
   access tokens, private user data, and raw tool output out of the note
   unless the user explicitly requests them.
3. Update the current day's DailyNote with a short dated summary. Include
   the task title, outcome, decisions, tests, follow-ups, and the task
   marker. Add a backlink to the detailed named note so the daily page is an
   index into the archive.
4. Make writes idempotent by marker, using the literal-containment rule:
   when a readback already shows this marker's final block or DailyNote
   summary, that write is done. If a write fails, follow the write-failure
   protocol and report honestly; never claim the journal was updated when it
   was not.

Use this daily-note template, where `<agent>` is the agent's name ("Codex" or
"Claude Code"):

```text
## <agent> — <task title>

<one or two sentence summary>
Decisions: <short list or none>
Tests: <short result or none>
Follow-ups: <short list or none>
Task marker: <marker>
```

When updating a DailyNote, send the detailed named note as a backlink in the
`backlinks` field rather than pasting a fake Markdown URL. Preserve existing
daily content by using `mode: "append"`. For the effective workspace, use the
current date as the DailyNote identifier
`date=YYYY-MM-DD&workspaceId=<effective-workspace-id>`; the journal MCP lazily
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
- Never add, change, or remove a per-project binding without an explicit user
  request and confirmation of the exact project path.
- Never bind, search, or write through the journal in a workspace that is
  blocked, non-confirmed, non-writable, or not write-ready.
- Never treat a failed MCP response as a successful journal write.
- If the MCP server is unreachable (unable to connect to `127.0.0.1:38473`),
  the Nerd Out Notes Mac app is not running or its MCP server is disabled —
  report that plainly (a locked screen or closed windows never cause this)
  and skip journaling for the task.
- Never treat search hits as marker identity: only literal
  `Task marker: <marker>` containment after `read_note` establishes which
  note belongs to a run.
- Never create a replacement note after an ambiguous `create_note`; recover
  through the write-failure protocol or report the journal state as unknown.
- Never let live journaling stall or abort the task: journaling failures
  degrade to a single end-of-task write and an honest report, not blocked
  work.
- Never let recall stall a task: when searches fail or return nothing
  relevant, proceed with the work, and mention the missing journal context
  only when the user explicitly asked about prior work.
- Never put credentials or entire conversation transcripts in the journal by
  default.
- If the user asks to stop journaling, stop writing for the task and leave the
  configuration file unchanged.
