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

The file is `<config-dir>/recall-journal.json`.

New writes use version 2:

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

## Reader-only structured project memory

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

Versions 3 and 4 are mutually exclusive with the legacy `scope`, `workspace`,
`journal`, `global`, and `projects` fields. Mixed or additional fields make the
file invalid so one prompt can never enter both protocols. Both versions are
**reader-only** in this plugin release: never create or update legacy journal
notes, Today summaries, structured sessions, or structured config files. Do
not write, migrate, reconfigure, or downgrade v3 or v4. Current setup and
reconfiguration flows below continue to write version 2 only.

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

1. If no config exists, tell the user the current filesystem project's absolute
   path and ask whether to configure journaling for this filesystem project or
   for all Codex or Claude Code projects globally. Do not silently select a
   scope.
2. Call `list_workspaces`. Offer only confirmed workspaces with both
   `roleWritable: true` and `writeReady: true`. Show name, id, role, and write
   status. If none qualify, stop and explain how to grant **Write** access or
   finish device readiness in Recall.
3. After the user selects a workspace, page through
   `list_projects({ workspaceId, limit: 100, offset })` until `hasMore` is false,
   never exceeding the advertised offset bound.
4. If the workspace has no Projects, skip the Project question and configure
   the workspace root. Otherwise ask whether named journal notes should use no
   Recall Project or one exact Project from the returned catalog, shown by name
   and id.
5. Ask where the short day summary should go. If `create_today_note` is in the
   MCP tool catalog, offer **Today timeline** (recommended) and **no day
   summary**. If it is absent, offer only no day summary and explain that Today
   summaries require an updated/restarted Recall app; the user can reconfigure
   after updating. Never offer the retired legacy DailyNote, and never
   configure Today by assuming `create_note.placement` will work.
6. Confirm the scope, absolute filesystem path when applicable, workspace,
   optional Recall Project, and summary target. Immediately re-run
   `list_workspaces`; if a Project
   was selected, page `list_projects` again and require the exact id in the same
   workspace.
7. Only after confirmation and revalidation, write v2 atomically: create the
   config directory if needed, write a temporary file in that directory, rename
   it over the target, then parse and validate the saved file. Keep it local and
   store no tokens, credentials, or note bodies.

If the file is malformed, show the problem and ask before replacing it. If a
saved workspace or Project is stale, preserve the old selection until the user
chooses and confirms a replacement; never silently clear the Project or fall
back to another workspace.

## Reconfigure or disable

When the user explicitly asks to reconfigure where journaling goes:

1. Ask whether to change the current filesystem-project destination or the
   global destination. Show the current absolute project path when relevant.
2. Ask whether to keep or change its workspace. If changing it, repeat the
   write-ready workspace selection.
3. For the resulting workspace, list Projects. Offer the current valid Project
   plus explicit choices to keep it, change it, or clear it to the workspace
   root. If there are no Projects, clearing a prior stale Project still requires
   confirmation.
4. Ask whether to keep or change the summary target. Offer only Today — and
   only when `create_today_note` is currently advertised — and no day summary;
   never offer the retired legacy DailyNote. When the saved target resolves to
   `dailyNote`, keeping it is not an option: run the migration below instead.
   Always write the canonical `summaryTarget` + `dailyNote` compatibility pair.
5. Revalidate and atomically save only the selected destination and summary
   setting. Preserve every other destination.

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
