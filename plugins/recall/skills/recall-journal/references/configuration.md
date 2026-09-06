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
context is missing, blocked, mismatched, or not ready. Version 7 replaces this
refusal with a named global destination; see "Version 7 structured
destinations" below.

Versions 3, 4, 5, 6, and 7 are mutually exclusive with the legacy `scope`,
`workspace`, `journal`, `global`, and `projects` fields. Mixed or additional
fields make the file invalid so one prompt can never enter both protocols.

Versions 3 and 4 are **reader-only**: never create or update legacy journal
notes, Today summaries, or structured sessions under them.

**Version 5 is the structured writer.** It carries the same
`projectMemory.defaultProject` shape as version 4 and is validated by the same
exact-shape rules, but a valid version 5 config directs the agent to write
structured sessions instead of legacy notes — see "Structured journaling
(versions 5 and 7)" in the skill. It never writes a legacy journal note or a
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

Version 5 always carries one exact, live, write-ready Recall Project as its
no-repository default; a workspace root is invalid. It is now a readable
compatibility format, like versions 3 and 4: the hook honors an existing
version 5 file unchanged, but new structured setups write version 7 below,
and an explicit upgrade may replace version 3, 4, 5, or 6 with version 7.
Never write version 3, 4, 5, or 6 during setup.

Never auto-migrate, downgrade, or change modes from lifecycle context. A mode
change is a separate, explicit configuration action with its own consequence
summary and confirmation. Older journal notes and Today cards remain untouched
archive under every mode change. Lifecycle context may report that the saved
file is older than version 7, or that it cannot be read as any version; both
are invitations to run the explicit flows in "Upgrading an older config to
version 7", never permission to rewrite the file.

## Version 7 structured destinations

Version 7 is the current structured writer shape. It keeps the version 5
session protocol and restores the version 2 destination model: an optional
global destination plus optional per-path destinations, every one naming a
Recall Project.

```json
{
  "version": 7,
  "projectMemory": {
    "enabled": true,
    "global": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    },
    "paths": {
      "/absolute/path/to/project": {
        "workspace": { "id": "workspace-id", "name": "Workspace name" },
        "recallProject": { "id": "project-id", "name": "Project name" }
      }
    }
  },
  "sessionLifecycle": { "enabled": false }
}
```

- `global` and `paths` are independently optional, but at least one
  destination must exist, or the file is invalid.
- Every destination names both a workspace and a Recall Project. A
  workspace-root destination is invalid: structured sessions, checkpoints,
  handoffs, and asks are Project-scoped end to end. Workspace-root
  destinations remain available only in the legacy journal-note mode.
- Every `paths` key is an absolute, non-root directory. Nested roots are
  allowed and the longest matching root wins; linked worktrees resolve to the
  main checkout path before matching, exactly as the legacy resolver does.
- `sessionLifecycle` is optional and carries the version 6 pilot unchanged
  (see "Version 6 session-recording pilot"). Omitting it, or writing
  `{ "enabled": false }`, keeps the pilot off.
- The shape is exact: any other key, including every legacy routing field,
  makes the file invalid so one prompt can never straddle protocols.
- The file must stay under 64 KiB. The hook and the session-recording adapter
  both reject a larger file as invalid, so the pilot flag can never change
  whether the file is honored. Refuse to save a version 7 file that would
  exceed that bound and ask the user to drop destinations instead.

Routing happens in the hook, in this order, and the hook's context names which
rung applied and the destination it chose on every prompt. The
session-recording adapter (see "Version 6 session-recording pilot") applies
the same order when the pilot is enabled under version 7:

1. **Saved filesystem-project destination.** The canonical working directory
   is inside a saved `paths` root. The hook names that workspace and Project;
   the agent opens its session there and calls `get_project_context` with
   that `projectUuid`, accepting only a result whose Project and workspace ids
   match. No `resolve_project` call is made, even inside a Git repository
   with a bound remote — the saved path wins.
   The saved path itself is never printed.
2. **Repository binding.** No path matched and the directory has repository
   identity with a supported non-local remote: `resolve_project` as in
   version 5, exact match only.
3. **Global destination.** Nothing above produced a Project — no repository
   identity, an unsupported or missing remote, or a `none`, `ambiguous`, or
   `not_ready` resolution — and a global destination exists. The version 5
   refusal to use the default after a repository routing failure is dropped
   for version 7, because the hook now names the destination on every prompt.
   Without a global destination, continue without project memory.

Once a rung has chosen a Project, no later rung is tried: a session that
fails to open means continue without project memory, and a
`get_project_context` result that is missing, blocked, mismatched, or not
ready never selects another Project. The session opens before the context
read so the read can be anchored to the predecessor `open_session` returns;
see the skill's session protocol. When the hook cannot classify the working
directory at all (missing or inaccessible), it withholds every destination
and the writer protocol with it, and the agent says so in its first reply.

A version 7 file without a global destination is **not** scoped to its saved
paths alone: outside them, rung 2 still applies, so every other repository
whose remote has an exact Recall binding opens structured sessions there.
Only a directory with no repository identity, or a repository whose remote is
missing, unsupported, or unresolved, is left without project memory. Say this
plainly whenever setup or reconfiguration produces a paths-only file.

Migration is always explicit (see "Explicitly changing journal modes"): a
version 5 `defaultProject` becomes `global`, and version 6 additionally keeps
its `sessionLifecycle` block. Lifecycle context never rewrites a file.

## Capability gate for structured setup (versions 5 and 7)

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

If any part is absent, do not save a new version 5 or version 7 configuration.
During first setup, explain the exact missing coverage; absence does not prove
whether the app, plugin, host, connection, or permission is responsible. Legacy
journal-note mode is a separate explicit user choice, never a runtime fallback.
Leave an existing v5 or v7 config and its configured mode unchanged. Runtime
must disclose the unavailable structured recording in the first user-visible
reply, skip writes, and continue the user's task without substitute journal or
Today notes. The version 5 gate is the version 7 gate.
Re-check the whole gate immediately before every version 7 save; never infer support from a plugin or
app version.

The delta read is a runtime capability, not part of this gate:
`sinceSessionUuid`, `entryLimit`, and `callerSessionUuid` on
`get_project_context`, the `closedSessions` section, and the activity summary
are discovered from the live input schema and each response at read time, and
their absence never blocks a version 7 save or changes the saved file.

## Version 6 session-recording pilot

This is a separate, explicit whole-mode opt-in for Claude Code or Codex. It is
off by default and is not automatically substituted for versions 1–5. Cursor
and the desktop extension are not certified for this adapter. Keep the user's
existing mode unless they choose the pilot after its consequences are clear.

```json
{
  "version": 6,
  "projectMemory": {
    "enabled": true,
    "defaultProject": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    }
  },
  "sessionLifecycle": { "enabled": true }
}
```

The shape is exact; no legacy keys are permitted. The default requires the
same live write-ready workspace and exact Project selection as version 5 and
is used only after proving no repository exists. Repository failures never
fall back to it. `sessionLifecycle.enabled: false` disables this mode without
entering an older writer. Disabling preserves pending delivery state.

The pilot also lives under version 7's `sessionLifecycle` block, so a user
with global or per-path destinations can enable it without giving them up:

```json
{
  "version": 7,
  "projectMemory": {
    "enabled": true,
    "global": {
      "workspace": { "id": "workspace-id", "name": "Workspace name" },
      "recallProject": { "id": "project-id", "name": "Project name" }
    }
  },
  "sessionLifecycle": { "enabled": true }
}
```

With the block enabled, the prompt hook yields to the adapter context exactly
as it does for version 6, and the adapter routes every event through the
same three rungs as the hook: a saved path (canonical longest root, linked
worktrees mapped to the main checkout) wins even over a bound remote; then
the exact `resolve_project` binding; then the `global` destination, which
also receives a repository whose remote is missing, unsupported, or
unresolved. A version 7 file with only `paths` has no global destination, so
outside its paths an unbound or unresolved repository and any no-repository
directory report scope unavailable rather than guessing. A repository that
Git cannot read at all stays unavailable under both versions. Enabling the
block requires the same host acceptance, catalog schema, certification, and
explicit confirmation as version 6. `sessionLifecycle.enabled: false`
disables the pilot without touching the destinations; unlike version 6, it
does not make the file inert, because the version 7 writer still runs (see
"Upgrading version 4, 5, or 6 to version 7").

Before enabling, require the installed host to accept `mcp_tool` hooks and the
current connected Recall catalog to advertise the complete version-1
`record_session_lifecycle` schema, including `expectedPrincipalDigest` and
`expectedSessionUuid`. Checkpoint/close tools must also meet the v5 schema
gate. Parser acceptance, a connection count, and a synthetic hook input are
not actual host event proof. Per-host certification must demonstrate real
edit, prompt, Stop, resume, compaction, and participant behavior on the exact
installed runtime, with missing connection/denial cases remaining unavailable.

Codex may additionally carry `sessionLifecycle.codexParticipantVerified: true`
**only after** actual ordinary tool events prove that absent participant ID
means main, and that subagents cannot report the parent's tuple. Otherwise
events lacking a participant ID are unsupported. Do not set this field on the
basis of CLI version, generated schema, hook inventory, or a fixture. Claude's
documented absent `agent_id` convention is main; malformed values still fail.

The plugin packages a read-only profile emitter. Resolve it relative to the
installed plugin root and run:

```sh
node hooks/session-lifecycle-profiles.mjs --host claude-code
node hooks/session-lifecycle-profiles.mjs --host codex
```

Use only the command for the current host. Merge the emitted entries through
the host's supported hook settings workflow, preserving unrelated hooks and
the existing Recall `UserPromptSubmit` context hook. Do not install duplicate
entries. These profiles are deliberately not included in the default plugin
manifest. After saving the v6 config, or a v7 config whose `sessionLifecycle`
block is enabled, with explicit confirmation, refresh the
host's plugin/MCP configuration through its supported interface and review the
resulting hooks. Codex trust remains an explicit user action in `/hooks`;
never edit trust state, copy hashes, or bypass review. No installed cache file
may be edited to activate this pilot.

The setup emits configuration only. It does not prove the currently running
conversation received the new tool catalog or handlers. Finish with this
run's local `get_session_recording_status`; use `begin_session_recording` only
for authorized substantive work. An unavailable or queued result is not
successful activation. Do not silently downgrade after a failure. For the
runtime proof matrix and limits, see the repository's
`docs/deterministic-session-lifecycle.md`.

## Resolve the current filesystem project

Show the user the resolved absolute path before saving a filesystem-project
destination in either mode — a version 2 `projects` entry or a version 7
`paths` entry.

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
     checkpoints, continuity, and optional day cards. Saved filesystem-project
     destinations route first, then an exact non-local Git-remote binding, then
     the global destination; the hook names which applied on every prompt.
     Every destination names a Recall Project. Writes version 7.
   - **Legacy journal note** — one named note per chat thread, with an optional
     Today summary. It supports a global destination, filesystem-path routes,
     and workspace-root destinations. Writes version 2.
   If the gate fails, offer only Legacy journal note and explain why. Do not
   silently select or combine modes.
2. In either mode, tell the user the current filesystem project's resolved
   absolute path (see "Resolve the current filesystem project") and ask
   whether this destination applies to that filesystem project or globally.
3. Call `list_workspaces`. Offer only confirmed workspaces with both
   `roleWritable: true` and `writeReady: true`. Show name, id, role, and write
   status. If none qualify, stop and explain how to grant **Write** access or
   finish device readiness in Recall.
4. After the user selects a workspace, page through
   `list_projects({ workspaceId, limit: 100, offset })` until `hasMore` is false,
   never exceeding the advertised offset bound.
5. For Structured Project activity, require one exact Project from that catalog,
   shown by name and id. If the workspace has no Projects, stop; never save a
   workspace-root destination. Explain that outside a saved path, repository
   work resolves to its exactly bound Project when one exists, and that the
   global destination receives repository work whose remote is unbound,
   unsupported, or unresolved. When the file will have no global destination,
   say plainly that exactly bound repositories still journal and that
   everything else outside the saved paths gets no project memory. For Legacy
   journal note, if there are no
   Projects configure the workspace root; otherwise offer the root or one exact
   Project.
6. For Legacy journal note, ask where the short day summary should go. If
   `create_today_note` is in the
   MCP tool catalog, offer **Today timeline** (recommended) and **no day
   summary**. If it is absent, offer only no day summary and explain that Today
   summaries require an updated/restarted Recall app; the user can reconfigure
   after updating. Never offer the retired legacy DailyNote, and never
   configure Today by assuming `create_note.placement` will work. Structured
   Project activity has no summary setting: the day card comes from
   `close_session`.
7. Confirm the complete mode and its routing. For Legacy journal note, also
   confirm the scope, absolute filesystem path when applicable, workspace,
   optional Recall Project, and summary target. For Structured Project activity,
   confirm the scope, the absolute filesystem path when applicable, and the
   exact workspace and Project. Immediately re-run
   `list_workspaces` and page `list_projects` again; require the exact Project id
   in the same workspace whenever a Project was selected. Re-check the full
   structured capability gate before saving version 7.
8. Only after confirmation and revalidation, atomically write the exact v2 or v7
   shape: create the
   config directory if needed, write a temporary file in that directory, rename
   it over the target, then parse and validate the saved file. Keep it local and
   store no tokens, credentials, or note bodies.

If the file is malformed, show the problem and ask before replacing it (see
"Repairing an unreadable config"). If a
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
   ask about a summary target, or use a workspace root. Adding a global or
   filesystem-project destination to a version 5 file is not a same-mode
   change: offer the explicit upgrade to version 7 below instead.
4. When keeping version 7, require the whole capability gate. Ask whether to
   change the current filesystem project's destination, add one for it, or
   change the global destination; show the resolved absolute path whenever a
   filesystem project is involved. Repeat the write-ready workspace selection
   when the workspace changes, then require one exact Project from that
   workspace, never a workspace root. Revalidate and atomically replace only
   the selected destination, preserving every other destination and the
   `sessionLifecycle` block unchanged; never add legacy routing fields or ask
   about a summary target.

## Explicitly changing journal modes

Only run a mode change when the user explicitly chooses it during setup or
reconfiguration. Before converting v1 or v2 to version 7, explain and confirm
all of these consequences together:

- Global and filesystem-path destinations that name a Recall Project carry
  over as version 7's `global` and `paths` entries after live revalidation.
  Workspace-root destinations cannot be translated losslessly: each one needs
  an exact Project chosen now, or it is dropped from the new file.
- Outside a saved path, repository sessions use an exact supported Git-remote
  binding; no remote, `none`, `ambiguous`, or `not_ready` fall back to the
  global destination when one exists, otherwise that repository has no
  structured journal.
- Legacy named-note journals stop receiving updates. New sessions and
  checkpoints are user-facing in **Today -> Now activity**, and Recall may
  create one app-owned Today card when the agent supplies a meaningful
  `daySummary` at close.
- Version 5 has no persistent `summaryTarget: "none"` preference, and neither
  does version 7. If an always-no-card preference is required, keep version 2.
- Existing journal notes and Today cards remain readable and are never moved,
  rewritten, or deleted.

Then revalidate every carried destination against `list_workspaces` and
`list_projects`, re-check the whole structured capability gate, show the exact
replacement v7 shape, and ask for final confirmation before the atomic save.
Converting version 3 requires selecting at least one destination the same way.
No older version upgrades implicitly. The bundled helper's `plan` step (see
"Upgrading an older config to version 7") lists the carried and dropped
destinations and asks the required question for each workspace-root
destination, so run it before explaining the consequences.

### Upgrading version 4, 5, or 6 to version 7

The upgrade is explicit and whole-file, never triggered by lifecycle context:

- Version 4 or 5: `projectMemory.defaultProject` becomes `projectMemory.global`
  after live revalidation of its workspace and Project. The routing
  consequence to confirm is that this destination now also receives repository
  work whose remote is unbound or unresolved, which version 5 refused.
- Version 6: the same, and `sessionLifecycle` is kept unchanged, so the pilot
  stays exactly as enabled or disabled as before.
- Either may add `paths` entries for the current filesystem project during the
  same upgrade, using the resolved absolute path.

Two of these conversions change what happens automatically, and the user must
confirm that consequence in so many words before the save:

- A version 4 file is reader-only; the version 7 file that replaces it is a
  writer. From the next prompt, agents open sessions, append checkpoints, and
  close with day summaries that appear in **Today -> Now activity** and on the
  Today timeline.
- A version 6 file with `sessionLifecycle.enabled: false` is inert: it emits
  no journal context at all. The same block under version 7 only keeps the
  pilot off, and the normal structured writer runs. Converting such a file
  therefore turns automatic journaling on. If the user wants journaling to
  stay off, do not convert; leave the version 6 file alone or remove it.

Say which of these applies, name the destinations that will receive the
records, and require an explicit yes before continuing.

Re-check the whole capability gate, show the exact replacement v7 shape, and
ask for final confirmation before the atomic save. The bundled helper's `plan`
step proposes exactly this translation, lists the carried destination for
live revalidation, and names these consequences together with the optional
questions — whether to keep the old default as the global destination or
choose a different Project, and whether to add a saved path for the current
filesystem project — so run it first; see "Upgrading an older config to
version 7".

An explicit switch from v5 or v7 to Legacy journal note is also a whole-mode
replacement, not a downgrade fallback. Explain that structured sessions remain
readable archive but stop receiving automatic entries; then run the Legacy
first-setup choices and confirm the complete replacement v2 shape.

When disabling version 5, show its exact default workspace and Project, confirm
that automatic structured sessions will stop while existing activity remains
readable, and remove the config file. Never replace it with an inert or invalid
v5 object. When disabling version 7, show every saved destination — the global
one and each absolute path with its workspace and Project — and confirm the
same way before removing the file; an enabled `sessionLifecycle` block stops
with it, and pending delivery state is preserved.

When asked to stop separate journaling for the current filesystem project,
confirm the exact path and delete only that `projects` (version 2) or `paths`
(version 7) entry; sessions then use the global destination if one exists. A
project-only version 2 file becomes disabled outside its saved paths
automatically, but a paths-only version 7 file does not: exactly bound
repositories still journal through the repository rung, so say so whenever a
removal leaves a version 7 file with no global destination. When removing the
final remaining destination, explicitly confirm disabling journaling and
remove the config file instead of writing an invalid empty v2 or v7 object.

## Upgrading an older config to version 7

Version 7 is the only shape new setups write, and every valid older file is
honored unchanged until the user explicitly upgrades it. The hook names the
saved version on every prompt for versions 1 through 6 — a version 6 file
only while its pilot is enabled, because an inert version 6 file means
someone turned journaling off — and asks the agent to offer the upgrade once
per session. Lifecycle context never rewrites a file; the only writer is the
bundled helper below, and it writes only what the user confirmed.

1. **When.** On an explicit invocation, offer the upgrade right after the
   Codex preflight. During implicit journaling, offer it once when finalizing
   the task's work, never mid-task and never more than once per session. If
   the user declines or does not answer, leave the file unchanged and do not
   ask again in that session; nothing records the decline, so a later
   session may offer again. When the retired DailyNote migration also applies
   to a version 1 or 2 file, make one combined ask: upgrading retires that
   summary target with the file.
2. **Gate first.** Before offering, inspect the live catalog for the whole
   structured capability gate above. If it fails, skip the offer in this
   session and say nothing about it unless the user asks; an upgrade that
   cannot be saved is not an offer.
3. **Plan.** Resolve the `scripts/` directory relative to this skill's
   `SKILL.md` and run the bundled helper for the current host, passing the
   session's working directory:

   ```sh
   scripts/upgrade-journal-config plan --host claude-code --cwd "$PWD"
   ```

   Use `--host codex` or `--host cursor` on those hosts. The helper prints
   one JSON object; it never talks to Recall and never writes. Read:
   - `status`: `current` (already version 7; say so and stop), `upgradable`
     (a complete file is proposed with nothing dropped), `needs_input` (a
     required question must be answered first), `invalid` (see "Repairing an
     unreadable config"), or `missing` (run first setup instead).
   - `proposed`: the exact replacement version 7 file, or `null` until the
     required questions are answered.
   - `carried`: every destination copied from the old file. Each one must be
     revalidated live before the save.
   - `dropped`: destinations that cannot be translated, with the reason
     (`workspace_root` or `duplicate_root`).
   - `consequences`: what changes automatically, in the user's terms. Relay
     every item; the ones that need an explicit yes in so many words are
     listed under "Upgrading version 4, 5, or 6 to version 7" and
     "Explicitly changing journal modes".
   - `questions`: `required` ones block the save; optional ones are offered.
     `global_project` lets the user keep the carried global destination or
     choose a different Project for it, which matters when the old default
     was picked with one repository in mind; `add_current_path` offers a
     saved destination for the resolved current filesystem project, whose
     absolute path is `filesystemProject.root`.
4. **Ask.** Show the source version, the carried and dropped destinations,
   and every consequence; ask each required question and offer each optional
   one. Any new Project is chosen exactly as in first setup: write-ready
   workspaces from `list_workspaces`, then one exact Project paged from
   `list_projects`, never a workspace root.
5. **Revalidate and confirm.** Re-run `list_workspaces` and page
   `list_projects` for every destination in the final file, require each
   exact Project id in its workspace, re-check the whole capability gate,
   show the exact replacement version 7 shape, and ask for final
   confirmation.
6. **Apply.** Only after that confirmation, hand the confirmed file to the
   helper, naming the version the plan was made from so a file that changed
   underneath is refused:

   ```sh
   scripts/upgrade-journal-config apply --host claude-code --expect-version 5 --input /path/to/confirmed.json
   ```

   The helper validates the exact version 7 shape and the 64 KiB bound,
   writes a temporary file beside the target, renames it into place, and
   reports `status: "written"` with `verified: true` after reading it back.
   A `rejected` result names the reason: fix the input or stop, and never
   write the file by hand to get past it. Tell the user the new file is in
   effect from the next prompt.

Per-version summary:

| From | Translation | What changes | Needs from the user |
| --- | --- | --- | --- |
| 5 | `defaultProject` becomes `global` | The global destination also receives unbound or unresolved repositories | One yes; optionally a different global Project |
| 6, pilot on | Same, `sessionLifecycle` kept | Same, inside the adapter | One yes |
| 6, pilot off | Same | Automatic journaling turns on | An explicit yes to that, or leave the file alone |
| 4 | Same | Reader-only becomes a writer | An explicit yes to that |
| 3 | Nothing carries over | Reader-only becomes a writer | At least one destination |
| 1 or 2 | Project-scoped destinations carry over | Mode change: legacy notes stop, workspace-root destinations need a Project, no persistent "no day summary" | Full mode-change confirmation plus a Project or a drop for each workspace-root destination |

### Repairing an unreadable config

When the hook reports that `recall-journal.json` exists but is not a valid
config, journaling is off and nothing may guess a destination from the file.
Run `plan`: its `invalid.description` names the problem — not valid JSON,
over the size bound, a version newer than this plugin supports, an
unsupported version, or a shape that does not match the version it names.
Show the user that description. A newer version means the plugin should be
updated, not the file rewritten. Otherwise ask whether to replace the file
through first setup or leave it alone; only an explicit choice replaces it,
and `apply` then writes the confirmed version 7 file without
`--expect-version`.

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
