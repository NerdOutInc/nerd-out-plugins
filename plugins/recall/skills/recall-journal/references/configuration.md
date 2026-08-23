# Journal destination configuration

Read this reference whenever the journal skill is explicitly invoked for first
setup, destination changes, disabling, or repair of a stale configuration.

## Vocabulary

- **Filesystem project:** the current codebase identified by an absolute local
  directory path.
- **Recall workspace:** the E2EE workspace selected through `list_workspaces`.
- **Recall Project:** the optional flat folder selected through
  `list_projects` inside that workspace.

Never call a filesystem project a Recall Project. Never reveal a saved
filesystem path in automatic hook context.

## Configuration locations and schemas

Use only the current agent's global configuration directory:

- Codex: `$CODEX_HOME`, falling back to `~/.codex`.
- Claude Code: `$CLAUDE_CONFIG_DIR`, falling back to `~/.claude`.
- Cursor: `$CURSOR_HOME`, falling back to `~/.cursor`.

The file is `<config-dir>/recall-journal.json`.

Legacy named-note writes use version 2:

```json
{
  "version": 2,
  "journal": { "summaryTarget": "today", "dailyNote": false },
  "global": {
    "workspace": { "id": "workspace-id", "name": "Workspace name" },
    "recallProject": { "id": "project-id", "name": "Project name" }
  },
  "projects": {
    "/absolute/path/to/project": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    }
  }
}
```

`global` and `projects` are independently optional, but at least one valid
destination must exist. `journal.summaryTarget` reads as `"today"`,
`"dailyNote"`, or `"none"`, but new writes may only select Today or none. Keep
`journal.dailyNote` for older plugin versions and always write the canonical
pair: Today is `{ "summaryTarget": "today", "dailyNote": false }` and no day
summary is `{ "summaryTarget": "none", "dailyNote": false }`. The legacy pair
`{ "summaryTarget": "dailyNote", "dailyNote": true }` remains readable from
older configs but is never written anymore: the Recall server has retired
DailyNote creation, so that target requires the migration below. When
`summaryTarget` is absent, legacy `dailyNote: false` means `none` and `true`
or an omitted value means the retired `dailyNote` target. Reject an explicit
pair that contradicts these mappings. Omit `recallProject` to journal named notes at the
workspace root; explicit `null` is invalid. Every filesystem-project key must
be an absolute, non-root path.

The hook continues to read version 1:

```json
{
  "version": 1,
  "scope": "global",
  "workspace": { "id": "workspace-id", "name": "Workspace name" },
  "journal": { "dailyNote": true },
  "projects": {
    "/absolute/path/to/project": {
      "workspace": { "id": "project-workspace-id", "name": "Project workspace name" }
    }
  }
}
```

Treat a valid v1 file's destinations exactly as they work today until the user
explicitly asks to reconfigure one. During that explicit reconfiguration — or
a confirmed summary-target migration — translate all preserved v1 destinations
to v2 and update only the requested setting.

Versions 1 and 2 remain the supported named-note writer. Their `global`
destination is deliberately available outside Git and outside every configured
filesystem-project path, which preserves automatic memory in general-purpose
agent threads. Never auto-migrate a version 1 or 2 config to structured project
memory: a silent migration could remove that global, non-repository behavior.

## Structured project memory

The hook also recognizes this exact version 3 activation shape:

```json
{
  "version": 3,
  "projectMemory": { "enabled": true }
}
```

Version 3 is repository-only structured project memory. It has no global or
non-Git fallback: the agent may call `resolve_project` only with a supported
non-local Git remote and may pass only an exact result to
`get_project_context`. No supported remote, an unavailable tool, `none`,
`ambiguous`, `not_ready`, or context that is not ready means continue without
project memory.

The hook also recognizes this exact version 4 reader configuration:

```json
{
  "version": 4,
  "projectMemory": {
    "enabled": true,
    "defaultProject": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    }
  }
}
```

Version 4 adds one explicit default Recall Project for sessions that have no
filesystem repository identity. Both the workspace and Recall Project are
required; a workspace-root default is invalid. The saved Project id is passed
to `get_project_context` as `projectUuid`, and the returned Project and
workspace ids must match the saved destination exactly.

Routing is fail-closed and happens before any named-note capability probe:

1. A `.git` directory or gitfile in the working directory or any ancestor is
   repository identity. Use repository-first routing even when that repository
   has no supported remote. With a supported non-local remote, only an exact
   `resolve_project` result may feed `get_project_context`.
2. Only when the hook proves the working directory exists and has no `.git`
   marker in any ancestor may the agent call `get_project_context` directly for
   the configured default Project. Do not call `resolve_project` or invent
   repository metadata on this route.
3. If the working directory is missing, inaccessible, or otherwise cannot be
   classified, continue without project memory and do not use the default.

The default is never a recovery path. Do not use it after a repository has no
supported remote, after `resolve_project` returns `none`, `ambiguous`, or
`not_ready`, when either required tool is unavailable, or when structured
context is missing, blocked, mismatched, or not ready.

Versions 3, 4, and 5 are mutually exclusive with the legacy `scope`,
`workspace`, `journal`, `global`, and `projects` fields. Mixed or additional
fields make the file invalid so one prompt can never enter both protocols.

Versions 3 and 4 are **reader-only**: never create or update legacy journal
notes, Today summaries, or structured sessions under them.

**Version 5 is the structured writer.** It carries the same
`projectMemory.defaultProject` shape as version 4 and is validated by the same
exact-shape rules, but a valid version 5 config directs the agent to write
structured sessions instead of legacy notes — see "Structured journaling
(version 5)" in the skill. It never writes a legacy journal note or a
hand-built Today card.

```json
{
  "version": 5,
  "projectMemory": {
    "enabled": true,
    "defaultProject": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    }
  }
}
```

Version 5 setup is available only after the live MCP catalog passes the whole
structured-surface check below. It always requires one exact, live, write-ready
Recall Project as its no-repository default; a workspace root is invalid. Never
write version 3 or version 4 during setup. They remain readable compatibility
formats, and an explicit upgrade may replace either one with version 5.

Never auto-migrate, downgrade, or change modes from lifecycle context. A mode
change is a separate, explicit configuration action with its own consequence
summary and confirmation. Older journal notes and Today cards remain untouched
archive under every mode change.

## Capability gate for version 5 setup

Inspect the live MCP catalog and its exact input schemas; do not probe by making
invalid calls. Offer **Structured Project activity** only when all of these are
advertised:

- `resolve_project` and `get_project_context`, with `projectUuid` accepted by
  `get_project_context`;
- `open_session`, accepting `workspaceId`, `projectUuid`, `sessionUuid`,
  `idempotencyKey`, `intent`, `branch`, and `lineageKey`;
- `append_entry`, accepting `workspaceId`, `projectUuid`, `entryUuid`,
  `idempotencyKey`, `sessionUuid`, `entryType`, `title`, and `text`;
- `close_session`, accepting `workspaceId`, `projectUuid`, `sessionUuid`,
  `idempotencyKey`, `outcome`, `runningSummary`, `followUps`, and `daySummary`.

If any part is absent, do not write version 5. During first setup, offer the
legacy journal-note mode only and explain that Structured Project activity
requires an updated and restarted Recall app. If a v5 config already exists,
leave it unchanged; runtime follows the skill's all-or-nothing fallback. Re-check
the whole gate immediately before every version 5 save; never infer support from
a plugin or app version.

## Resolve the current filesystem project

Show the user the resolved absolute path before saving a filesystem-project
destination.

1. Normalize the session working directory to an absolute real path when
   possible.
2. In Git, run `git rev-parse --path-format=absolute --show-toplevel
   --git-common-dir`. For a normal non-bare checkout, use the parent directory
   of the absolute common `.git` directory as the stable main-checkout root.
   This maps linked worktrees back to the main checkout.
3. Outside Git or when resolution fails, use the absolute session working
   directory.
4. Reject the filesystem root. Preserve nested saved roots; the longest matching
   root wins.

## First setup

Run setup only on an explicit skill invocation. An implicit reminder with no
valid effective destination stays silent.

1. If no config exists, inspect the capability gate above. When it passes, ask
   the user to choose one complete mode:
   - **Structured Project activity** — recommended when the user wants agent
     work to appear in **Today -> Now activity**. Recall owns durable sessions,
     checkpoints, continuity, and optional day cards. Repository sessions route
     by an exact non-local Git-remote binding; the configured default Project is
     used only when the hook proves there is no repository identity.
   - **Legacy journal note** — one named note per chat thread, with an optional
     Today summary. It supports a global destination, filesystem-path routes,
     and workspace-root destinations.
   If the gate fails, offer only Legacy journal note and explain why. Do not
   silently select or combine modes.
2. Call `list_workspaces`. Offer only confirmed workspaces with both
   `roleWritable: true` and `writeReady: true`. Show name, id, role, and write
   status. If none qualify, stop and explain how to grant **Write** access or
   finish device readiness in Recall.
3. After the user selects a workspace, page through
   `list_projects({ workspaceId, limit: 100, offset })` until `hasMore` is false,
   never exceeding the advertised offset bound.
4. For Structured Project activity, require one exact Project from that catalog,
   shown by name and id. If the workspace has no Projects, stop; never save a
   workspace-root default. Explain that repository work may resolve to another
   exactly bound Project and that this default is not used after any repository
   routing failure. For Legacy journal note, if there are no Projects configure
   the workspace root; otherwise offer the root or one exact Project.
5. For Legacy journal note, first tell the user the current filesystem project's
   absolute path and ask whether this destination applies to that filesystem
   project or globally. Then ask where the short day summary should go. If
   `create_today_note` is in the
   MCP tool catalog, offer **Today timeline** (recommended) and **no day
   summary**. If it is absent, offer only no day summary and explain that Today
   summaries require an updated/restarted Recall app; the user can reconfigure
   after updating. Never offer the retired legacy DailyNote, and never
   configure Today by assuming `create_note.placement` will work.
6. Confirm the complete mode and its routing. For Legacy journal note, also
   confirm the scope, absolute filesystem path when applicable, workspace,
   optional Recall Project, and summary target. For Structured Project activity,
   confirm the exact default workspace and Project. Immediately re-run
   `list_workspaces` and page `list_projects` again; require the exact Project id
   in the same workspace whenever a Project was selected. Re-check the full
   structured capability gate before saving version 5.
7. Only after confirmation and revalidation, atomically write the exact v2 or v5
   shape: create the
   config directory if needed, write a temporary file in that directory, rename
   it over the target, then parse and validate the saved file. Keep it local and
   store no tokens, credentials, or note bodies.

If the file is malformed, show the problem and ask before replacing it. If a
saved workspace or Project is stale, preserve the old selection until the user
chooses and confirms a replacement; never silently clear the Project or fall
back to another workspace.

## Reconfigure or disable

When the user explicitly asks to reconfigure where journaling goes:

1. Show the current mode. Ask whether to keep that mode or explicitly switch
   modes. Never treat ordinary reconfiguration language as permission to
   migrate. A mode switch skips the same-mode steps below and follows
   "Explicitly changing journal modes."
2. When keeping Legacy journal-note mode:
   - Ask whether to change the current filesystem-project destination or the
     global destination. Show the current absolute project path when relevant.
   - Ask whether to keep or change its workspace. If changing it, repeat the
     write-ready workspace selection.
   - For the resulting workspace, list Projects. Offer the current valid Project
     plus explicit choices to keep it, change it, or clear it to the workspace
     root. If there are no Projects, clearing a prior stale Project still
     requires confirmation.
   - Ask whether to keep or change the summary target. Offer only Today — and
     only when `create_today_note` is currently advertised — and no day summary;
     never offer the retired legacy DailyNote. When the saved target resolves to
     `dailyNote`, keeping it is not an option: run the migration below instead.
     Always write the canonical `summaryTarget` + `dailyNote` compatibility pair.
   - Revalidate and atomically save only the selected destination and summary
     setting. Preserve every other destination.
3. When keeping version 5, require the whole capability gate, then offer only
   exact live Projects from write-ready workspaces. Revalidate and atomically
   replace only `projectMemory.defaultProject`; never add legacy routing fields,
   ask about a summary target, or use a workspace root.

## Explicitly changing journal modes

Only run a mode change when the user explicitly chooses it during setup or
reconfiguration. Before converting v1 or v2 to version 5, explain and confirm
all of these consequences together:

- The old global and filesystem-path destinations cannot be translated
  losslessly and will not carry into v5. Repository sessions use an exact
  supported Git-remote binding; no remote, `none`, `ambiguous`, `not_ready`, or
  unavailable routing means no structured journal for that repository.
- The one selected default is an exact Recall Project and applies only when the
  hook proves no filesystem repository identity exists. A workspace-root global
  destination has no v5 equivalent.
- Legacy named-note journals stop receiving updates. New sessions and
  checkpoints are user-facing in **Today -> Now activity**, and Recall may
  create one app-owned Today card when the agent supplies a meaningful
  `daySummary` at close.
- Version 5 has no persistent `summaryTarget: "none"` preference. If an
  always-no-card preference is required, keep version 2.
- Existing journal notes and Today cards remain readable and are never moved,
  rewritten, or deleted.

Then select and revalidate one exact write-ready default Project, re-check the
whole structured capability gate, show the exact replacement v5 shape, and ask
for final confirmation before the atomic save. Converting version 3 requires
the same target selection and confirmation. Converting version 4 may retain its
default only after live revalidation. Neither reader version upgrades
implicitly.

An explicit switch from v5 to Legacy journal note is also a whole-mode
replacement, not a downgrade fallback. Explain that structured sessions remain
readable archive but stop receiving automatic entries; then run the Legacy
first-setup choices and confirm the complete replacement v2 shape.

When disabling version 5, show its exact default workspace and Project, confirm
that automatic structured sessions will stop while existing activity remains
readable, and remove the config file. Never replace it with an inert or invalid
v5 object.

When asked to stop separate journaling for the current filesystem project,
confirm the exact path and delete only that `projects` entry; sessions then use
the global destination if one exists. A project-only config becomes disabled
outside that saved path automatically. When removing the final remaining
destination, explicitly confirm disabling journaling and remove the config file
instead of writing an invalid empty v2 object.

## Migrating a retired DailyNote summary target

The Recall server no longer creates DailyNotes, so a config whose effective
summary target resolves to `dailyNote` — an explicit
`summaryTarget: "dailyNote"` pair, or a v1 or v2 file with no `summaryTarget`
whose `journal.dailyNote` is `true` or omitted — is stale. Its destinations
stay fully valid and detailed named-note journaling continues unchanged; only
the day-summary setting needs a one-time migration:

1. Ask the user once where the summary target should go. As in first setup,
   offer **Today timeline** (recommended) only when `create_today_note` is
   advertised, and always offer **no day summary**; when Today is unavailable,
   explain that updating/restarting Recall enables it and that deferring is
   fine. On an explicit invocation ask immediately; during implicit journaling
   ask when finalizing the task's entry instead of interrupting the work.
2. On a choice, write the canonical pair atomically as in first setup,
   preserving every saved destination unchanged and translating a v1 file to
   v2. Selecting Today still requires `create_today_note` in the current tool
   catalog.
3. If the user defers, leave the config unchanged, write no day summary, and
   do not ask again in the same session. Never write or append a DailyNote
   while the stale target remains, and never report the skipped summary as a
   journaling failure.

## Compatibility failures

Project-aware configuration requires the new MCP contract. Never save a Project
selection or silently downgrade when it is unavailable:

- If `list_projects` is absent from the tool catalog, explain that the native
  Recall app is older and must be updated.
- If it is advertised but fails with `Unknown MCP tool: mcp_list_projects` or an
  equivalent unknown web-method error, explain that the native catalog is ahead
  of the hosted/cached web app. Ask the user to bring Recall's main window
  forward, let it adopt the current web build or restart, then retry.
- Connection and authorization failures follow the main skill's ordinary Recall
  failure rules. Do not rewrite configuration during any compatibility failure.

Today-summary configuration has the same fail-closed rule. If
`create_today_note` is absent, do not save `summaryTarget: "today"`. If it is
advertised but dispatch reports an unknown tool/web method, keep the existing
configuration unchanged and ask the user to bring Recall forward, let the web
build update, or restart the app. Never fall back to `create_note.placement`
or the retired DailyNote behind the user's back.
