# Conversation-segment recording pilot

**Status: implemented behind explicit v6 opt-in; actual host certification is
still required.** Existing v1–v5 journaling protocols and hook registrations
stay unchanged; connection diagnostics also cover Codex and Cursor.
No installed cache, user config, hook trust, or production sessions are modified
by this implementation. Since plugin 0.34.0 a version 7 journal config carries
the same block as `sessionLifecycle`, so global and per-path structured
destinations can coexist with the pilot. Under version 7 the adapter routes
exactly as the prompt hook does, through the shared
`bridge/journal-destinations.mjs`: a saved path (canonical longest root,
linked worktrees mapped to the main checkout) wins even over a bound remote,
then the exact remote binding, then the global destination, which also
receives a repository whose remote is missing, unsupported, or unresolved.
See the journal configuration reference.

This supersedes the earlier proposal to open at SessionStart, close at Stop,
open a second helper connection from a hook, or overwrite an automatic intent.
Those semantics would confuse transport, turns, and durable work segments.

## Ownership and boundaries

A conversation segment continues through prompts, steering, waiting,
compaction, reconnect, and resume. Stop records yield only. A terminal segment
can receive its original late checkpoint/close through the app's explicit
recovery rules; new work gets a successor, never resurrects it. Distinct
participants must not share the parent's mapping. Ambiguous host identity is
unsupported, not permission to guess.

`bridge/session-adapter.mjs` wraps the unchanged `bridge/index.mjs` transport
supervisor. Ordinary tools and internal lifecycle calls share the same stream
and authenticated Recall connection. The adapter creates no socket listener,
OAuth client, token, or second helper. Existing helper attestation, approval,
account, scope, workspace policy, key-readiness, and fallback rules still apply.
Digests are correlation keys, never authorization. The MCP connection proves
the authorized caller, not whether a particular call came from a configured
hook or model-selected tool use. Event origin remains client-reported; neither
tool descriptions nor hidden catalog entries can attest it.

The app owns the durable principal-scoped run mapping, segment generation,
neutral immutable intent, automatic-origin marker, canonical encrypted opening,
observation revision, receipts, and terminal transitions. The plugin owns
bounded metadata, routing, deduplication, exact retries, and host feedback.
Model judgment owns checkpoint and outcome prose. An automatic end has no
fabricated outcome or day summary.

## Host profiles

`hooks/session-lifecycle-profiles.mjs --host claude-code|codex` emits a profile
without modifying anything. Profiles are absent from the default manifest.
See the journal configuration reference for confirmed setup and supported host
review; never patch installed plugin caches or trust state.

| Boundary | Claude Code | Codex | Effect |
| --- | --- | --- | --- |
| Edit boundary | `Edit`, `Write` | `apply_patch` | Begin or observe the same segment |
| Other observed tools | `Read`, `Bash`, `Glob`, `Grep` | `Bash`, `read_file`, `view_image` | Refresh an acknowledged segment only |
| Substantive review/shell/reasoning | Explicit begin tool | Explicit begin tool | Begin without guessing shell effects |
| UserPromptSubmit | Observation | Observation | Never creates a segment |
| Stop | Yield | Yield | Never closes; output is `{}` |
| Explicit `/clear` | Best-effort SessionEnd observation | Not registered | End without prose; output is `{}` |
| SessionStart, reconnect, compact | No opening hook | No opening hook | Preserve identity; wait for real work |

Classification uses an explicit tool allowlist, never shell parsing or transcript
inspection. PreToolUse records a work boundary before execution; it does not
prove an edit succeeded. No generic MCP wildcard is registered, avoiding
recursive self-observation.

PostToolUse is observation-only. It must find the exact acknowledged PreToolUse
receipt for that tool invocation on the same still-ACTIVE segment. A terminal
predecessor, a successor, or missing/evicted/legacy receipt evidence suppresses
the completion; it cannot open a segment or refresh unrelated work. An already
frozen uncertain completion still retries its original bytes and predecessor.

Claude's profile uses server `plugin:recall:recall`; Codex uses `recall`.
`mcp_tool` uses the existing connected server. A missing server/tool remains
unavailable recording, never a new connection attempt. Codex has no MCP
SessionEnd handler in this profile. Claude's short shared shutdown budget makes
clear best effort. Optional participant substitution must still be demonstrated
on the actual runtime; literal, malformed, or unproved values fail before any
app mutation. Official contracts:
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks), and
[Codex plugin hooks](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks).

### Connector diagnostics are a separate host capability

Version 0.32.0 builds on the merged missing-connector work in
[PR #52](https://github.com/NerdOutInc/recall-plugins/pull/52). The normal journal
hooks and doctor now select Claude Code, Codex, or Cursor explicitly. A fresh,
bounded process snapshot supplies advisory evidence only; positive results
are never cached and raw argv is neither returned nor persisted.

| Host boundary | Process verdict | Required next evidence |
| --- | --- | --- |
| Recognized Claude Code session CLI | Present or absent in that snapshot | This conversation's Recall read tools and actual call outcome |
| Shared Claude app ancestor | Unknown | This conversation's tools |
| Codex app-server, terminal UI, resume, fork | Unknown: shared process | This conversation's tools |
| Other Codex CLI modes, including exec | Unknown: ownership unverified | A demonstrated conversation boundary and current tools |
| Cursor IDE | Unknown: shared process | This conversation's tools |
| Branded Cursor CLI | Unknown: ownership unverified | Actual runtime boundary proof and current tools |

The inspected [Codex 0.149.1 terminal UI source](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/tui/src/app.rs#L596)
retains multiple thread listeners and side threads in one app session. A CLI
mode name therefore cannot prove connector ownership. Cursor's installed MCP
extension operates at workspace scope. Its
[official CLI installer](https://cursor.com/install) identifies a branded binary
path, but that alone does not establish per-conversation ownership. Generic
`agent` or `node` executable names are not Cursor identity. These are evidence
snapshots, not host version gates.

For Codex and Cursor, an unknown process verdict adds a current-tool check to
the existing journal context. It does not silently assume connection health,
change journal modes, or authorize automatic recording. Version 6 retains its
adapter context even when the bridge is missing or unknown.

Doctor is passive unless the user authorizes `--probe`; a fresh initialize can
trigger consent or OAuth and proves only that new connection. Optional
`--session-tools available|missing|unknown` reports the caller's current **read**
tool inventory. It is not attestation, a successful call, write permission, or
recording status. Missing write tools alone can reflect policy or capability.
Cursor diagnostics do not enable a Cursor recording profile.

## Local tools and routing

`get_session_recording_status` is a local read-only tool. Only explicit v6
enablement plus the complete native lifecycle schema exposes
`begin_session_recording` and `session_lifecycle_hook`. Existing native
tools retain their definitions; names are never shadowed.

The hook endpoint is advertised and callable by the same authorized client as
ordinary tools. Models are instructed to use begin/status, never to fabricate
host events, but that instruction is not an access control. Its narrow schema
and the app's authenticated scope checks remain the enforcement boundaries.
The automatic-origin marker identifies the recording path, not an attested
host event or proof that an edit occurred. Real-host certification proves the
configured integration's behavior, not an unforgeable event-origin guarantee.

Local input accepts only `protocolVersion`, `host`, `eventName`, `cwd`,
`conversationId`, and optional `participantId`, `turnId`, `toolUseId`,
`toolName`, `requestId`, and `endReason`. No tool bodies, prompt, command,
transcript path, or raw result is accepted. Claude's documented missing
participant means main. Missing Codex participant is unsupported unless an
explicit capability flag records actual host proof; it is not a CLI minimum.

The adapter verifies cwd and repository locally. A supported non-local remote
must resolve exactly through `resolve_project`; no local basename is sent.
Under version 6, missing/inaccessible repositories, invalid remotes, ambiguous
matches, unavailable tools, and blocked scope never use a default, and only
proved absence of repository identity permits the configured exact default
Project. Under version 7 a saved path wins first and the global destination
also receives unbound or unresolved repositories; an unreadable repository
stays unavailable under both. The app revalidates membership, policy, and key
state.

Host/run/participant/event values use domain-separated SHA-256 over JSON tuple
encoding. Raw host IDs and paths never cross the native lifecycle boundary.
The app additionally binds operations to its authenticated principal. Local
files are metadata, not encrypted journal content or host attestation.

## Shared version-1 contract

`record_session_lifecycle` input:

```text
protocolVersion: 1
operation: begin | observe | yield | end | status
workspaceId, projectUuid: exact explicit scope
host: claude-code | codex
conversationDigest, participantDigest, eventDigest: lowercase SHA-256 hex
sequence: positive safe integer
occurredAtMs: nonnegative safe integer, frozen before first send
source: mutating_tool | explicit_begin | prompt | tool | stop | session_end | recovery
expectedSessionUuid?: UUID
expectedPrincipalDigest?: lowercase SHA-256 hex
```

The adapter requires the principal digest on every mutation after a fresh
status handshake. Mapped observe/yield/end and advancement of a known
predecessor require the expected session. Only mutating-tool or explicit-begin
sources create. Host/source claims do not grant scope.

Result:

```text
protocolVersion: 1
status: recording | yielded | ended | not_started | queued | unavailable | conflict
sessionUuid?, segmentGeneration?, observationRevision?, sessionState?
reasonCode?, principalDigest?, lastSequence?
pendingDeliveries?: { checkpoints, closes, scope: "this_device" }
```

Session state is ACTIVE, CLOSED, or ABANDONED. Authorized results include the
principal digest and `lastSequence` (zero before accepted events), independently
of observation revision. A queued opening may include a durable reservation
UUID; that is not an acknowledged encrypted session. Exact queued retries may
finish it. After local state loss, an eligible begin with the reserved UUID and
`lastSequence + 1` recovers the same reservation and original opening. It never
advances an unmaterialized generation. Status alone never materializes it.

Local output adds authorized exact `scope` for checkpoint/close calls,
optional `unresolvedLifecycleEvents`, `pendingDeliveriesAvailable`, and
`eventOrigin: "client_reported"`. Omitted delivery
counts mean unknown, not zero. A recording successor never hides pending
predecessor deliveries. Recording acknowledgement does not claim that prose or
a Today card was saved.

`unresolvedLifecycleEvents` is present only after a fresh account handshake and
a successful read of that account's run queue. Omission means unread or
unavailable coverage; zero means a known empty queue. The durable diagnostic
uses `retryState: "unknown"` when that coverage is unavailable, preserving the
account's pending request bytes until authenticated recovery. Checkpoint and
close delivery coverage remains separate in `pendingDeliveries`.

## Durability, races, and limits

A fresh same-stream status handshake selects local account/run/scope state
before any outbox read. A different signed-in principal cannot replay the old
account's events. Frozen requests retain their exact principal, scope,
predecessor, digest, sequence, and timestamp through restart. Allocator recovery
uses the maximum local/app sequence without rewriting queued bytes. Native
receipts settle retries; conflicts remain visible. Stale concurrent status or
old receipts cannot roll back a newer acknowledgement.

Local state is capped at 64 KiB per file, 256 files, 16 queued observations,
and 32 local receipts. Files use 0600, directories 0700, bounded reads,
no-follow opens, atomic replacement, and fsync. Per-run locks wait at most
250 ms; only a provably dead owner can be reaped under an exclusive claim.
Unknown owners and interrupted reaper claims remain busy. Age never grants
permission to steal a lock. Corrupt, symlinked, extra-key, or scope-substituted
state fails closed without replay.

Host frames are capped at 64 KiB, adapter-owned replies at 4 MiB, outstanding
requests at 128, and simultaneous local calls at 16. Ordinary native replies
retain the existing transport's size behavior, including large full-note reads
with the pilot off or on. An oversized adapter-owned reply rejects that call
without disconnecting ordinary traffic. Client request IDs are remapped to
avoid internal collisions; late internal replies are consumed locally. A hook
processes at most four queued events within a 4-second call budget (1 second
on Claude clear). Transport uncertainty gets at most one identical retry;
typed refusals never trigger retry or downgrade. Generic local diagnostics
contain no account, Project, session UUID, path, or raw host identity. Cached
diagnostics are not current connection/account proof.

## Verification and release gate

Node regressions exercise actual adapter/profile/state/multiplexing code and
the unchanged-supervisor wrapper: duplicates, participants, terminal
successors, account changes, restart retry, reservations, corrupted state,
locks, deadlines, routing, config exclusion, status, and delivery visibility.
App tests independently verify authorization, reservations, receipts, encrypted
materialization, observation CAS, and late delivery.

Read-only parser probes on 2026-08-27 accepted MCP-tool hook registrations in
installed Codex 0.149.1 and plugin App Server 0.150.0-alpha.8. They were listed
as untrusted session flags; no hook was approved or executed. These are evidence
labels, not minimum versions. Claude Code 2.1.246 also accepted the emitted
profile through strict plugin validation; an invalid-handler control was
rejected. That validation executed no hook. CLI identity and parser acceptance
are not actual event certification.

Before enabling, a user-authorized disposable host run must prove:

1. A real edit boundary reaches the existing connection and receives a durable
   app acknowledgement without model-assisted `open_session`.
2. Prompt, Stop, waiting, compact, reconnect, and resume retain one segment.
3. Actual subagents cannot share the parent tuple; ambiguous hosts fail.
4. Terminal work produces one successor; uncertain callbacks retain exact
   receipts, and old checkpoints never bump successor activity.
5. Missing tools, denied/revoked approval, account changes, app absence, and
   restart retain failure classification and visible pending state.
6. Actual host context parsing delivers correct UUID/scope/status without
   forcing a response or continuing the task at Stop.

Synthetic fixtures and parser probes do not complete those checks. Keep v6 and
host proof flags off until they pass. Release app capability and plugin as
coordinated, independently compatible artifacts: old apps report unavailable
local status and existing configs retain their protocol. Unit tests alone are
not a production rollout. The tiny diary robot still needs its road test.
