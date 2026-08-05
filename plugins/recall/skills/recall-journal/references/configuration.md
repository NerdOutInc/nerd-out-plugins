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
  "journal": { "dailyNote": true },
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
destination must exist. `journal.dailyNote` may be omitted and defaults to
`true`. Omit `recallProject` to journal named notes at the workspace root;
explicit `null` is invalid. Every filesystem-project key must be an absolute,
non-root path.

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

Treat a valid v1 file exactly as it works today until the user explicitly asks
to reconfigure a destination. During that explicit reconfiguration, translate
all preserved v1 destinations to v2 and update only the requested destination.

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
   status. If none qualify, stop and explain how to grant Read & write access or
   finish device readiness in Recall.
3. After the user selects a workspace, page through
   `list_projects({ workspaceId, limit: 100, offset })` until `hasMore` is false,
   never exceeding the advertised offset bound.
4. If the workspace has no Projects, skip the Project question and configure
   the workspace root. Otherwise ask whether named journal notes should use no
   Recall Project or one exact Project from the returned catalog, shown by name
   and id.
5. Confirm the scope, absolute filesystem path when applicable, workspace, and
   optional Recall Project. Immediately re-run `list_workspaces`; if a Project
   was selected, page `list_projects` again and require the exact id in the same
   workspace.
6. Only after confirmation and revalidation, write v2 atomically: create the
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
4. Revalidate and atomically save only the selected destination. Preserve every
   other destination.

When asked to stop separate journaling for the current filesystem project,
confirm the exact path and delete only that `projects` entry; sessions then use
the global destination if one exists. A project-only config becomes disabled
outside that saved path automatically. When removing the final remaining
destination, explicitly confirm disabling journaling and remove the config file
instead of writing an invalid empty v2 object.

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
