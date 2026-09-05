## Conversation segments (version 6 pilot)

Version 6 uses one durable conversation segment across prompts, steering,
waiting, compaction, reconnect, and resume. `Stop` is a yield observation, not
a close. A later work boundary starts a successor only after the previous
segment is terminal. Distinct participants have distinct mappings; never use
the parent's identity as a substitute for a missing participant identity.

### Begin and inspect this exact run

The plugin's local `begin_session_recording` and
`get_session_recording_status` tools use the existing Recall MCP connection.
Use only tools actually exposed in this conversation and the identity supplied
by the v6 hook context. Pass `protocolVersion: 1`, the exact `host`,
`conversationId`, `participantId`, and the current absolute `cwd`. These local
identifiers are hashed before lifecycle calls reach the Recall app. Never send
prompts, transcript paths, command bodies, tool inputs, or raw tool results.

For status, pass `eventName: "Status"`. For explicit beginning, pass
`eventName: "ExplicitBegin"` and a caller-minted stable `requestId`. Reuse the
identical begin payload on uncertainty. Substantive reviews, investigation,
shell-only, and reasoning work require this explicit begin: automatic opening
only recognizes Claude `Edit`/`Write` or Codex `apply_patch`. Merely connecting,
starting a prompt, or reading files does not create a session. Do not call the
`session_lifecycle_hook` tool yourself to simulate host events. It is an ordinary
authorized MCP tool intended for configured hooks, not a host-only endpoint;
event origin is client-reported, not independently attested.

Only `recording` or `yielded` with an acknowledged `sessionUuid` establishes a
recorded segment. Use the returned exact `scope.workspaceId` and
`scope.projectUuid` with it. `queued` can contain a reserved UUID, which is
**not** an acknowledgement; do not append prose to that reservation. An
`ended` status describes the predecessor, not current recording. For new
substantive work, an explicit begin or validated edit boundary lets the app
create the successor safely.

If local tools are missing, or recording is `unavailable`, `queued`, or
`conflict`, disclose that concise status and continue the user's work. Missing
participant identity is unsupported: never invent one or enable a proof flag
to make the error disappear. Do not start another helper, reauthorize, create
a duplicate session, or change the user's mode as a workaround.

### Checkpoints and a real ending

Model judgment still supplies checkpoint and outcome prose. Use the
checkpoint, failure, and close-result sections of [structured-writer.md](structured-writer.md) only; do not run its session-opening protocol, with the acknowledged exact scope and session UUID. Keep every uncertain entry or close attached to its
original UUID/idempotency key/payload. An app delivery queue is not saved
history. Never relabel a predecessor checkpoint as successor activity; a new
entry may refer back explicitly when that is the honest meaning.

If `append_entry` reports `session_sealed`, preserve the exact checkpoint and
call `get_session_recording_status` with this run's exact local identity. A
local seal error, generic tool failure, missing row, or stale mirror is only a
reconciliation trigger; it does not prove that the mapped predecessor ended.
Only an authenticated, scope-checked status confirming that exact predecessor
is CLOSED or ABANDONED supplies terminal proof. If the result is unavailable,
keep the original delivery unresolved. Once the predecessor is confirmed
terminal, the next validated edit boundary or an explicit begin for new
substantive work can advance exactly once; the rejection itself must not open
a successor. The adapter always refreshes authoritative status before that
boundary. Reconcile the original checkpoint independently through the app's
append-receipt path with its unchanged IDs, session pointer, and payload. A
missing receipt does not justify dropping or recreating it while earlier
delivery remains uncertain, and an eligible close keeps its original identity.

Close only when the conversation segment actually ends, using `close_session`
and the model-written outcome, running summary, follow-ups, and optional day
summary. An ordinary reply, waiting for user input, or Stop does not end it.
The automatic neutral intent is immutable; do not invent an intent-update API
or use a generic automatic outcome to claim work was completed. A best-effort
Claude `/clear` observation may record an end without a summary. It never
fabricates outcome prose or substitutes for the durable close envelope.

Inspect delivery results independently. The adapter's optional
`pendingDeliveries` counts checkpoints and closes for this run **on this
device**, including predecessors; omission means unavailable, not zero.
Recording a successor never clears earlier uncertainty. `unresolvedLifecycleEvents`
is an optional, separate local lifecycle queue count, present only after a
fresh account handshake and a successful read of that account's run queue.
Omission means unknown; zero means a known empty queue. Acknowledged recording
does not mean checkpoint prose, a close, or a Today card was saved. The v5 day-card
result meanings still apply when a model close requests one.
