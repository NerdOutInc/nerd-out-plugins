### Codex hook preflight

On an **explicit** invocation in Codex, verify the bundled
`UserPromptSubmit` hook before configuring or writing the journal. The plugin's
`SessionStart` handler comes from the same `hooks.json` manifest and carries
the protocol once per session; the per-prompt handler is the one the helper
below inspects, and its reminder points at the journal skill whenever the
session-start context is missing. Resolve the
`scripts/` directory relative to the parent `SKILL.md`, then run
the absolute path to `../scripts/check-codex-hook` (relative to this reference) from the session's current
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
  invoke this skill again. If `cause` is `hook_manifest_load_failed`, explain
  that Codex found Recall but could not parse its hook manifest; report the
  exact `codexExecutable` (and `codexExecutableSource`), `codexVersion`, and
  `hookManifestDiagnostics` supplied by the helper instead of reducing the
  failure to "hook missing." `codexUserAgent` is supporting evidence when the
  version cannot be parsed.
  Otherwise include any non-empty `errors` or `warnings` from the helper when
  they make the diagnosis more specific.
- `ambiguous`, `unknown`, or `unavailable`: do not guess. Ask the user to open
  `/hooks` and verify that exactly one enabled Recall `UserPromptSubmit` hook
  is listed and trusted, then invoke this skill again.

Hook trust is a user-controlled security decision. Never write
`hooks.state`, copy a `trusted_hash`, use
`--dangerously-bypass-hook-trust`, or imply that a normal chat request can
approve the hook. The supported action is the user's explicit review in
`/hooks`.
