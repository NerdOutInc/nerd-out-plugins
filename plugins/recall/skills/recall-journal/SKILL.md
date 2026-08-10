---
name: recall-journal
description: Keep a concise, searchable journal of agent work in Recall and read it back as the agent's long-term memory. Use when the user invokes the recall-journal skill ($recall:recall-journal in Codex, /recall:recall-journal in Claude Code), asks to configure or reconfigure where journaling goes, or when plugin lifecycle context reports a valid recall-journal.json destination for the current agent. Configure either the current filesystem project or a global default, select a write-ready Recall workspace and optional Recall Project, recall and cite relevant prior notes before deciding, keep one live journal note per chat thread with human-readable toggle entries, add a tiny ELI5 summary card to the configured Today timeline or no day summary, and migrate retired legacy DailyNote summary targets the first time they appear.
---

# Recall Journal

Use Recall as a global scratchpad for decisions and task history. The journal
is deliberately human-first: each chat thread keeps exactly one journal note
that a person can skim — a dateless topic title, a one-or-two-sentence intro,
and a list of collapsible toggle entries whose summary lines read like a story
of the work — while everything an agent needs later hides inside the collapsed
details. It is also two-way: a journal that is written but never read back is
dead weight, so recall from the archive at the start of related work is as
much a part of this skill as writing at the end. It is also live: the thread's
note opens when substantive work begins and grows at checkpoints, so an
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
then journal the current work. When the valid global configuration already
applies, invoke this skill implicitly for every task going forward, including
tasks where the user did not mention journaling. Implicit activation covers
the whole task: recall relevant journal context before substantive work
(see "Recall before working" below), open or continue the thread's journal
note and append entries while working (see "Journal as you go" below), and
wrap the entry up at the end.
Validate the saved workspace with `list_workspaces` before writing. If the
destination includes a Recall Project, page `list_projects` and require the
exact id in that workspace. If either target is unavailable, pause journal
writes and ask the user to reconfigure instead of switching, clearing the
Project, or writing unfiled.

The plugin's `UserPromptSubmit` hook checks only whether this agent's v1 or v2
config has a valid effective destination, then adds lifecycle context that names
the effective workspace and optional Recall Project, tells the agent to
search the journal when the task may relate to prior work, and tells it to
load this skill when meaningful work begins so the thread's note can be opened
and updated live. When the host supplies one, the hook also names the chat
thread's stable id, which anchors the thread's single journal note across
context compaction. The hook never reveals filesystem paths, validates
targets, or writes notes itself. Recall searches may target the effective
destination directly, but always perform the live validation above before
implicit writes.

Use the summary target supplied by the hook context. In v2 it comes from
`journal.summaryTarget`: `today`, `dailyNote`, or `none`. A legacy config with
no `summaryTarget` maps `dailyNote: false` to `none` and `true` or an omitted
value to `dailyNote`. A target that resolves to `dailyNote` is stale — the
Recall server has retired DailyNote creation — so handle it through
"Migrating a retired DailyNote target" below and never write a DailyNote
summary. The detailed thread-note journal always remains the source of truth;
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
may already be journaled, search first and reference or extend the existing
context instead of duplicating it. When recall surfaces an earlier thread's
note on the same work, do not append to it — this thread gets its own note
that links back to the predecessor (see below).

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
substantive work begins — after recall — open the thread's note; append an
entry at checkpoints while working; wrap up before the task's last response.
An interrupted session then leaves a partial note ending at its last
checkpoint instead of nothing.

### One note per chat thread

Each chat thread that reaches substantive work owns exactly one journal note
in the effective destination, and every task in the thread appends entries to
that same note. Never create a new journal note per task. Before opening one,
confirm the thread has not already opened its note: the uuid is normally in
context, and after context compaction the thread id search below recovers it.

A new chat thread always opens a fresh note, even when it continues earlier
journaled work. Continuity lives in links, not shared notes: when recall
surfaces the predecessor thread's note, mention the continuation in the new
note's opening entry and materialize a backlink to the predecessor with
`update_note_content` `backlinks` (`create_note` cannot attach backlinks).

One escape hatch: when the thread pivots to work truly unrelated to the
note's topic — not a new phase, follow-up, or tangent of the same work — open
a second thread note for the new stream so each note stays coherent, and say
so in both notes' entries. Splitting related work is never allowed.

### Thread identity and journal markers

Two hidden identifiers make the journal recoverable without ever showing
machine noise to the reader:

- **Thread id.** The hook context names the chat thread's stable id when the
  host provides one. It groups everything this thread wrote.
- **Journal marker.** Each journal note mints its own fresh marker when it is
  created: a kebab-case task slug plus at least 64 random bits — for example
  `fix-sync-retries-9f2ab41c77d03e58` from `openssl rand -hex 8`, or a UUID
  in place of the hex suffix. Never reuse a marker across notes.

Both live only inside toggle details, in one metadata line at the end of each
entry (see the format below). Never put markers, thread ids, or timestamps in
note titles, intro text, summary lines, or Today cards.

Search never establishes identity. `keyword_search` is fuzzy, prefix-matching
lexical search, so its results are only candidates. Whenever a decision
depends on locating this thread's note — continuing after compaction,
recovering a lost uuid, deduplicating — read each candidate with `read_note`
and keep only notes whose body literally contains `Journal marker: <marker>`
(or, when searching by thread, `thread <thread-id>`). Count matches after
that literal filter, never from raw search hits: act on exactly one literal
marker match, and treat zero or several as "not found" or "ambiguous", never
as license to guess. Titles and dates never establish identity.

### What the note looks like

- **Title:** a short topic phrase naming the work — `OAuth scope upgrade
  fixes`, `Journal instructions revamp`. No dates, no ids, no agent names.
  When the thread changes direction, the title changes with it (see
  "Finalizing a task").
- **Intro:** one or two always-visible sentences under the title saying what
  the thread is working on and where it stands. Keep it current through
  curation as the thread evolves.
- **Entries:** everything else is `<details><summary>` toggle blocks, which
  Recall renders as native collapsible toggles. The summary line is the human
  layer; the collapsed details are the agent layer.

```markdown
Making Recall journal notes readable for humans. Toggle format landed;
rename support is next.

<details>
<summary>Started: rework the journal note format</summary>

Objective: one note per chat thread, human-readable summaries, agent
detail hidden in toggles. Continues [Journal format exploration](https://recall.nerdout.com/notes/...).

Journal marker: journal-note-format-9f2ab41c77d03e58 · thread b425db1a-153d-45d2-850c-93ac0271f495 · 2026-08-09 14:02

</details>

<details>
<summary>Confirmed toggles render natively in Recall</summary>

- `<details><summary>` HTML in Markdown maps to TipTap Toggle nodes;
  regular Markdown works inside the details body.
- Gotcha: `read_note` format `text` flattens toggles and newlines — use
  format `html` before any rewrite.

Journal marker: journal-note-format-9f2ab41c77d03e58 · thread b425db1a-153d-45d2-850c-93ac0271f495 · 2026-08-09 14:41

</details>
```

Summary lines are one plain-language sentence a person can skim — "Found the
retry bug in the sync queue", "Tests pass after the token cache fix" — with
no paths, markers, hashes, or jargon. Details are freeform: capture whatever
the next agent needs — decisions and why, rejected alternatives, files and
paths, commands and their results, gotchas, follow-ups — and end every
details block with the metadata line
`Journal marker: <marker> · thread <thread-id> · <YYYY-MM-DD HH:MM>`,
omitting the `thread` part when the host provides no id. Keep secrets, access
tokens, private user data, and raw tool output out of the note unless the
user explicitly requests them.

Formatting mechanics: put `<summary>` on its own line right after
`<details>`, leave a blank line after `</summary>` and before `</details>`,
and ordinary Markdown (lists, code fences, bold, links) renders inside the
details body.

### Entry lifecycle

- **Open.** When substantive work begins, create the note with `create_note`
  — title, intro, and an opening toggle (`Started: <objective in plain
  language>`) whose details hold the objective, starting context, any
  predecessor link, and the metadata line. Keep the returned uuid for the
  whole session.
- **Checkpoints.** Append one toggle per checkpoint with `update_note_content`
  `mode: "append"`. Checkpoints are judgment calls: a durable decision made, a
  significant step completed, tests or builds run with their results, a
  blocker or change of direction, or a long autonomous stretch that would
  otherwise leave the note stale. Never journal per tool call or per file
  edit; a handful of entries per task is typical.
- **Wrap-up.** Before the task's last response, append a closing toggle whose
  summary states the outcome in plain words ("Shipped the friendlier journal
  format") and whose details preserve what matters for a future agent:
  outcome, decisions and rejected alternatives, important files, commands and
  tests run, blockers, and next steps. That shape is a suggestion, not a
  schema — adapt it to the task — but always include the metadata line.
- Later tasks in the same thread keep appending to the same note: new opening
  toggle, checkpoints, wrap-up.

### Curating the note

The thread's journal note is a living document, and this thread is its only
writer, so tidying it is allowed and encouraged: refresh the intro to match
where things stand, merge a trail of checkpoint toggles into one cleaner
entry, tighten summary lines, drop detail that later work made irrelevant.
Curate when the note has stopped telling its story cleanly — typically at a
wrap-up — not as constant churn.

To curate, read the note with `read_note` format `"html"` — the plain-text
format flattens toggles, lists, and even line breaks into one line, so it can
never be the source for a rewrite. Faithfully rebuild the Markdown from the
HTML: `<details>` and `<summary>` tags carry over as-is, drop each
`<div data-type="detailsContent">` wrapper (its children sit directly between
`</summary>` and `</details>`), and convert rich content back to Markdown.
Then write the whole body with `update_note_content` `mode: "replace"`.

Every rewrite must preserve the note's identity — at least one metadata line
with its journal marker (and thread id) survives — and must not lose
still-relevant detail or backlinks. Curation this way applies only to the
current thread's own journal note: replacing any other note still requires
the user's explicit request.

### Write-failure protocol

Any journal write that errors, times out, or loses its response may still
have landed. Recover by reading, never by blind retry, and never let
recovery stall the task itself:

- **Opening `create_note`:** the note may exist even though its uuid never
  arrived. Query the marker with destination-scoped `keyword_search`
  (including `projectId` when configured), read each candidate,
  and keep only literal `Journal marker: <marker>` matches. Exactly one →
  adopt that note's uuid and continue. Zero or several → the journal state
  is unknown: stop journal writes, continue the task, report the state at
  the end, and never create a replacement note.
- **Checkpoint append:** stop further appends and keep working; before the
  wrap-up, read the note once and fold anything missing into the closing
  toggle.
- **Wrap-up append:** read the note; if the closing toggle already landed,
  the entry is closed. Append it again only after the readback confirms it
  is absent.
- **Curation replace:** re-read the note. If the rewrite landed, continue;
  if it half-failed or the state is unclear, leave the body as found and
  fall back to appends for the rest of the session.
- **Today summary:** `create_today_note` is idempotent by its
  `idempotencyKey`. After an error or lost response, repeat the exact same
  request once; a matching note returns unchanged. If the server rejects the
  key as already used with different content, the day's card already exists —
  treat that as success and never mint a fresh key to force another card.
  Verify the returned workspace, optional Project, uuid, href, and positive
  `timelineAt`.
- If a recovery readback itself fails, report the journal state as unknown
  rather than claiming or guessing that any write landed.

## Finalizing a task

At the end of meaningful work, close out the entry:

1. Append the wrap-up toggle, and curate the note when it has gotten messy:
   refresh the intro, consolidate checkpoint toggles that no longer earn
   their place, and make sure the summary lines alone tell the story.
2. Retitle when the thread moved. If the work drifted from what the current
   topic-phrase title says, rename the note (dateless topic phrase, as
   always) with `rename_note`, passing `noteType: "NamedNote"`, the note's
   uuid, and the new title; the tool is advertised alongside the other write
   tools on newer Recall builds and never touches body content. When
   `rename_note` is not advertised, keep the existing title and
   mention in the final response that the note deserves a new name so the
   user can rename it in Recall; never fake a rename by rewriting body
   content, and never treat the missing tool as a journaling failure.
3. Apply the configured summary target only after the detailed wrap-up
   succeeds:
   - **Today:** the thread gets at most one card per day. At the thread's
     first wrap-up of the day, call `create_today_note` exactly once, passing
     the effective `workspaceId`, optional `projectId`, and
     `<thread-id>-<YYYY-MM-DD>` as `idempotencyKey` (fall back to the
     thread's first journal marker in place of the thread id when the host
     provides none). Use a 4–8 word plain-language title and one or two ELI5
     sentences, then a blank line and the literal heading
     `### Full journal entry`, and pass exactly one backlink to the thread's
     journal note titled with that note's current title — retitle first (step
     2) so the link text is current; the server renders the link after the
     heading. No other headings, no bullets, paths, commands, hashes, ids,
     jargon, test inventories, or visible markers. Later wrap-ups the same
     day add nothing to the timeline; cards cannot be updated once created.
   - **dailyNote:** retired. Never write the DailyNote; keep the detailed
     entry, skip the day summary, and run the one-time migration below.
   - **none:** write no day-summary note.
4. Verify every summary write. If `create_today_note` is not in the tool catalog,
   keep the finalized thread note, skip the Today summary, and tell the user
   to update/restart Recall; never fall back to `create_note.placement` or
   the retired DailyNote. If dispatch reports an unknown tool/web method, Recall's native
   catalog is ahead of its hosted/cached web app—bring the main window forward,
   let it update or restart, then retry later. Never claim a summary landed
   when it did not.

Whenever the final chat response links to the thread's journal note or any
other Recall note, use a Markdown link whose complete URL starts with
`https://recall.nerdout.com`. Never present a relative `/notes/...` path as a
chat link; resolve a relative MCP `href` against that origin first.

The Today card is the day's index entry, not a second technical journal: the
timeline shows its title and first lines, and selecting it opens the short
body with the journal link. It should read like an explanation to a
five-year-old. Good: `Made journal notes friendlier` / `The work diary now
reads like a story, and the techy bits hide inside little dropdowns.` Bad:
`Implemented idempotent MCP Yjs timeline dispatch.`

### Migrating a retired DailyNote target

The Recall server no longer creates DailyNotes: a missing DailyNote is no
longer lazily materialized, and `update_note_content` against one fails with
"Note not found. Daily Notes can no longer be created; use placement=today
when creating a note." Plugin versions up to 0.14.0 offered DailyNote day
summaries, so an older config may still resolve its summary target to
`dailyNote`. That target now means "needs migration", never "write a
DailyNote":

1. Journal the detailed thread-note entry exactly as usual; the destination is
   unaffected.
2. When finalizing the session's first meaningful task, ask the user once
   where the summary target should go, mirroring first setup: offer the
   **Today timeline** (recommended) only when `create_today_note` is in the
   current tool catalog, and always offer **no day summary**. When Today is
   unavailable, say that updating/restarting Recall enables it; the user may
   also defer. On an explicit skill invocation, ask right away instead.
3. Apply the choice through the summary-target migration in
   [references/configuration.md](references/configuration.md): write the
   canonical pair atomically and preserve every saved destination, translating
   a v1 file to v2.
4. If the user defers, leave the config unchanged, skip day summaries, do not
   ask again this session, and mention the skipped summary briefly in the
   final response — it is not a journaling failure.

For historical context: these summaries formerly lived in one workspace-level
DailyNote per day, as appended `## <agent> — <task title>` blocks carrying a
`Task marker: <marker>` line and a backlink to the detailed note. Older
journal notes likewise used one note per task with visible `Task marker:`
lines and dated headings. All of it remains readable archive — the recall
searches above still surface it, and literal `Task marker:` containment still
identifies those legacy entries — but the old shapes are never written
anymore.

## Read and maintenance operations

- Use `list_notes` for a lightweight archive index and to locate prior thread
  notes, legacy per-task notes, or historical DailyNotes.
- Use `read_note` for a note's content. Plain text is fine for skimming, but
  it flattens toggles and line breaks — request `format: "html"` whenever
  structure matters, and always before a rewrite.
- Use `keyword_search` for exact terms, paths, and identifiers; use
  `semantic_search` for concepts and paraphrases.
- Use `update_note_content` with `mode: "append"` for new toggle entries and
  `mode: "replace"` only to curate the current thread's own journal note or
  when the user explicitly asks to rewrite a note.
- Keep summaries short enough to scan. The thread note is the durable detail;
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
- Never treat search hits as note identity: only literal
  `Journal marker: <marker>` (or `thread <thread-id>`) containment after
  `read_note` establishes which note belongs to this thread.
- Never create a replacement note after an ambiguous `create_note`; recover
  through the write-failure protocol or report the journal state as unknown.
- Never show machine bookkeeping to the reader: markers, thread ids, and
  timestamps stay inside toggle details, never in titles, intros, summary
  lines, or Today cards.
- Never replace the body of any note other than the current thread's own
  journal note without the user's explicit request, and never let a curation
  rewrite drop the note's marker metadata or still-relevant content.
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
