---
name: recall-journal
description: Keep a concise, searchable journal of agent work in Recall and read it back as the agent's long-term memory. Use when the user invokes the recall-journal skill ($recall:recall-journal in Codex, /recall:recall-journal in Claude Code), asks to configure or reconfigure where journaling goes, or when plugin lifecycle context reports a valid recall-journal.json destination for the current agent. Configure either the current filesystem project or a global default, select a write-ready Recall workspace and optional Recall Project, recall and cite relevant prior notes before deciding, journal meaningful work live under a unique task marker, add a tiny ELI5 summary to the configured Today timeline or no day summary, and migrate retired legacy DailyNote summary targets the first time they appear.
---

# Recall Journal

Use Recall as a global scratchpad for decisions and task history. The journal
is deliberately summary-first: save the useful context, not a surprise
transcript dump. It is also two-way: a journal that is written but never read
back is dead weight, so recall from the archive at the start of related work
is as much a part of this skill as writing at the end. It is also live: an
entry opens when substantive work begins and grows at checkpoints, so an
interrupted session leaves a partial record instead of nothing.

## Activation and configuration

### Codex hook preflight

On an **explicit** invocation in Codex, verify the bundled
`UserPromptSubmit` hook before configuring or writing the journal. Resolve the
`scripts/` directory relative to this `SKILL.md`, then run
the absolute path to `scripts/check-codex-hook` from the session's current
working directory; do not resolve it relative to the user's project. The helper
is read-only: it asks Codex's App Server to list the active hooks and prints one
JSON object.

Do not run this preflight in Claude Code, which does not use Codex's per-hook
trust state. Do not run it for an implicit activation caused by the hook's own
lifecycle context: receiving that context already proves the hook ran for the
current prompt, and checking again on every turn would add needless overhead.

Handle the helper's `status` as follows:

- `trusted` or `managed`: continue with normal journal configuration and use.
- `untrusted` or `modified`: tell the user that Recall's automatic journal
  hook needs review. Ask them to type `/hooks`, open the `UserPromptSubmit`
  event, review the Recall handler, trust it, and then send a fresh prompt.
  Stop this invocation before configuring or writing the journal.
- `disabled`: ask the user to type `/hooks`, open `UserPromptSubmit`, and
  re-enable the Recall handler. Stop this invocation.
- `missing`: explain that the Recall hook is not loaded. Ask the user to
  confirm that the plugin is installed and enabled, start a new thread, and
  invoke this skill again. Include any non-empty `errors` or `warnings` from
  the helper when they make the diagnosis more specific.
- `ambiguous`, `unknown`, or `unavailable`: do not guess. Ask the user to open
  `/hooks` and verify that exactly one enabled Recall `UserPromptSubmit` hook
  is listed and trusted, then invoke this skill again.

Hook trust is a user-controlled security decision. Never write
`hooks.state`, copy a `trusted_hash`, use
`--dangerously-bypass-hook-trust`, or imply that a normal chat request can
approve the hook. The supported action is the user's explicit review in
`/hooks`.

### Journal configuration

For any explicit setup, reconfiguration, disabling, or stale-config repair,
read and follow [references/configuration.md](references/configuration.md).
It defines the v1-compatible/v2 schemas, canonical absolute filesystem-project
path, workspace and Recall Project selection, compatibility errors,
confirmation, and atomic write protocol.

Each effective destination contains one write-ready Recall workspace and
optionally one live Recall Project inside it. A filesystem-project destination
overrides the global destination; a v2 config may intentionally contain only
filesystem-project destinations. Outside every saved path with no global
destination, journaling is disabled and the hook stays silent.

When the skill is invoked explicitly, configure the destination if necessary and
then journal the current task. When the valid global configuration already
applies, invoke this skill implicitly for every task going forward, including
tasks where the user did not mention journaling. Implicit activation covers
the whole task: recall relevant journal context before substantive work
(see "Recall before working" below), open the task's entry and append
progress while working (see "Journal as you go" below), and finalize the
entry at the end.
Validate the saved workspace with `list_workspaces` before writing. If the
destination includes a Recall Project, page `list_projects` and require the
exact id in that workspace. If either target is unavailable, pause journal
writes and ask the user to reconfigure instead of switching, clearing the
Project, or writing unfiled.

The plugin's `UserPromptSubmit` hook checks only whether this agent's v1 or v2
config has a valid effective destination, then adds lifecycle context that names
the effective workspace and optional Recall Project, tells the agent to
search the journal when the task may relate to prior work, and tells it to
load this skill when meaningful work begins so the entry can be opened and
updated live. The hook never reveals filesystem paths, validates targets, or
writes notes itself. Recall searches may target the effective destination
directly, but always perform the live validation above before implicit writes.

Use the summary target supplied by the hook context. In v2 it comes from
`journal.summaryTarget`: `today`, `dailyNote`, or `none`. A legacy config with
no `summaryTarget` maps `dailyNote: false` to `none` and `true` or an omitted
value to `dailyNote`. A target that resolves to `dailyNote` is stale — the
Recall server has retired DailyNote creation — so handle it through
"Migrating a retired DailyNote target" below and never write a DailyNote
summary. The detailed named-note journal always remains the source of truth;
the summary target controls only the short day-level index.

Distinguish explicit from implicit activation. An explicit skill invocation
(`$recall:recall-journal` in Codex,
`/recall:recall-journal` in Claude Code) may prompt for scope, workspace, and
Recall Project when the config or current destination is missing or invalid. An
implicit invocation with no valid effective destination must skip journaling
for that task without prompting or interrupting unrelated work; wait for the
user to invoke the skill explicitly before starting setup.

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
- Use `list_notes`, recent Today entries, or historical DailyNotes when the
  user points at time rather than topic ("what did we do yesterday?", "where
  did we leave off?").
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

Always pass the effective workspace's `workspaceId` to named-note
`list_notes`, `keyword_search`, `semantic_search`, and `create_note`. When the
destination includes a Recall Project, also pass its `projectId` to all four;
never omit it as a fallback. A Today summary uses `create_today_note` with that
same explicit `workspaceId` and optional `projectId`. Because legacy DailyNotes
are workspace-level and Project filters exclude them, perform time-based
DailyNote lookup separately with only the `workspaceId`.
`update_note_content` targets the resolved note and must
never move it between workspaces or Projects. If destination validation or
search fails, continue the task without journal context and run explicit
reconfiguration before any write; never silently broaden the search.

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
in the opening block and every appended detailed block. For a Today summary it
is passed invisibly as `idempotencyKey`; never put the marker in the human-facing
Today title or body.

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
  the entry opens, passing the destination's workspace id and optional Project
  id, and keep its uuid for the whole session; every progress
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
  arrived. Query the full marker with destination-scoped `keyword_search`
  (including `projectId` when configured), read each candidate,
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
- **Today summary:** `create_today_note` is idempotent by the task marker. After
  an error or lost response, repeat the exact same request once; a matching
  note returns unchanged and a different request fails closed. Verify the
  returned workspace, optional Project, uuid, href, and positive `timelineAt`.
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
3. Apply the configured summary target only after the detailed final block
   succeeds:
   - **Today:** call `create_today_note` exactly once for the meaningful task,
     passing the effective `workspaceId`, optional `projectId`, and the task
     marker as `idempotencyKey`. Use a 4–8 word plain-language title and one
     ELI5 sentence, ideally no more than 180 characters. No headings, bullets,
     paths, commands, hashes, ids, jargon, test inventories, or visible marker.
     Add exactly one real backlink titled `Read the full journal entry` to the
     detailed named note. This is a scan-friendly status card, not a second
     technical journal.
   - **dailyNote:** retired. Never write the DailyNote; keep the detailed
     entry, skip the day summary, and run the one-time migration below.
   - **none:** write no day-summary note.
4. Verify every summary write. If `create_today_note` is not in the tool catalog,
   keep the finalized detailed note, skip the Today summary, and tell the user
   to update/restart Recall; never fall back to `create_note.placement` or
   the retired DailyNote. If dispatch reports an unknown tool/web method, Recall's native
   catalog is ahead of its hosted/cached web app—bring the main window forward,
   let it update or restart, then retry later. Never claim a summary landed
   when it did not.

Whenever the final chat response links to the detailed journal entry or any
other Recall note, use a Markdown link whose complete URL starts with
`https://recall.nerdout.com`. Never present a relative `/notes/...` path as a
chat link; resolve a relative MCP `href` against that origin first.

The Today card should read like an explanation to a five-year-old. Good:
`Made journal updates easy to scan` / `Recall can now show one tiny update for
each finished job.` Bad: `Implemented idempotent MCP Yjs timeline dispatch.`

### Migrating a retired DailyNote target

The Recall server no longer creates DailyNotes: a missing DailyNote is no
longer lazily materialized, and `update_note_content` against one fails with
"Note not found. Daily Notes can no longer be created; use placement=today
when creating a note." Plugin versions up to 0.14.0 offered DailyNote day
summaries, so an older config may still resolve its summary target to
`dailyNote`. That target now means "needs migration", never "write a
DailyNote":

1. Journal the detailed named-note entry exactly as usual; the destination is
   unaffected.
2. When finalizing the session's first meaningful task, ask the user once
   whether to switch this journal's summary target to the **Today timeline**
   (recommended when `create_today_note` is advertised) or to **no day
   summary**. On an explicit skill invocation, ask right away instead.
3. Apply the choice through the summary-target migration in
   [references/configuration.md](references/configuration.md): write the
   canonical pair atomically and preserve every saved destination, translating
   a v1 file to v2.
4. If the user defers, leave the config unchanged, skip day summaries, do not
   ask again this session, and mention the skipped summary briefly in the
   final response — it is not a journaling failure.

For historical context: these summaries formerly lived in one workspace-level
DailyNote per day, as appended `## <agent> — <task title>` blocks carrying a
`Task marker: <marker>` line and a backlink to the detailed note. Existing
DailyNotes remain readable — the time-based lookups in "Recall before
working" still apply — but they are archive, not a write target.

## Read and maintenance operations

- Use `list_notes` for a lightweight archive index and to locate prior named
  notes or historical DailyNotes.
- Use `read_note` for full text or HTML when a note's details matter.
- Use `keyword_search` for exact terms, paths, and identifiers; use
  `semantic_search` for concepts and paraphrases.
- Use `update_note_content` with `mode: "append"` for new dated entries and
  `mode: "replace"` only when the user explicitly asks to rewrite a note.
- Keep summaries short enough to scan. The named note is the durable detail;
  the Today card is only the day's navigation page.

## Failure and safety rules

- Never select a workspace silently, especially after a workspace id changes.
- Never add, change, or remove a per-project binding without an explicit user
  request and confirmation of the exact project path.
- Never bind, search, or write through the journal in a workspace that is
  blocked, non-confirmed, non-writable, or not write-ready.
- Never use a Recall Project that is missing, blank, archived, deleted, or in a
  different workspace. Stop named-note writes and ask for reconfiguration.
- Never treat a failed MCP response as a successful journal write.
- Never write or append a DailyNote summary: the server has retired DailyNote
  creation, and a config that still selects it gets the one-time migration
  prompt instead.
- If the MCP server is unreachable (unable to connect to `127.0.0.1:38473`),
  the Recall Mac app is not running or its MCP server is disabled —
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
- If the user asks to stop journaling only this task, stop writing and leave the
  config unchanged. If they ask to disable or remove a saved destination,
  follow the explicit confirmation flow in the configuration reference.
