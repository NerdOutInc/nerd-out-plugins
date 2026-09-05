One compatibility exception is reader-only **version 3 and version 4 structured
project memory**. When lifecycle context explicitly identifies either valid
version, follow that context instead of the legacy named-note workflow
and read compact project context when the required tools are available, but
never create or update a legacy journal note or Today summary. Never create a
structured session under version 3 or version 4: those versions read structured
memory and never write it.

Version 3 is repository-only. Use a supported non-local Git remote with
`resolve_project`, and pass only an exact result to `get_project_context`.
Version 4 is repository-first: the same exact-resolution rule applies whenever
filesystem repository identity exists, including repositories with no usable
remote. Its explicit default Recall Project may be read directly with
`get_project_context` only when lifecycle context proves no repository identity
exists. Never use that default after no usable remote, an unavailable tool, a
`none`, `ambiguous`, or `not_ready` result, or context that is not ready. If
routing or reading fails, continue the user's task without project memory and
without prompting for a legacy destination.

Never rewrite, migrate, reconfigure, or downgrade a v3 or v4 config through the
v1/v2 configuration flow. An explicit, confirmed whole-mode upgrade may replace
v3, v4, v5, or v6 with v7 through the configuration reference. In particular, do not
auto-migrate v1/v2 global users: their global destination intentionally supplies
memory outside Git and cannot be translated losslessly to a Project-only mode.
Select this protocol before inspecting named-note capabilities: in v3 or v4,
do not run the legacy capability probe or call `list_note_activity`,
`read_note`, or `update_note_content` for project memory.

Read [project-context.md](project-context.md) for every structured Project context response.
