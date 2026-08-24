# Deterministic session lifecycle for structured journaling

**Status: proposal.** This document specifies the design and its open
questions; it deliberately ships no behavior change. The v5 protocol below
refers to the structured journaling shipped in plugin 0.28.0.

## Problem

Version 5 structured journaling depends on the model *choosing* to call
`open_session` when substantive work begins. Instructions are injected on
every prompt, but injection is not execution: a model can skip the call,
compose it with wrong parameter names, or misclassify an error and continue
without project memory. A live incident (2026-08-24) did exactly that — a
malformed `resolve_project` call was misread as "continue without project
memory," the session never opened, and the Now dashboard silently showed
nothing while the agent worked for an entire session.

Two shipped mitigations narrow the gap — the malformed-call retry rule and
the first-reply failure-report requirement — but they still run through model
volition. Any lifecycle step owned by the model can be skipped by the model.

## Goal

A session exists on the Now dashboard whenever the Recall app is reachable
and the working directory resolves to a Project — regardless of model
behavior. The model's contribution shrinks to what genuinely needs judgment:
a useful intent, checkpoint entries, the outcome, and the day summary.

## Non-goals

- **No bypass of the fail-closed transport.** App not running, workspace
  blocked, helper unattested: still no session, exactly as today. (The
  companion recall-app work — attested-connection presence rows on Now —
  covers visibility for those cases.)
- **No per-prompt heartbeat.** One open at session start, one close at
  session end; checkpoints stay judgment calls.
- **No change to entry authorship.** `append_entry` content remains
  model-written; Recall has no language model and E2EE rules out server-side
  authorship.

## Proposed mechanics

- **New hook registrations.** `SessionStart` (Claude Code) and the closest
  equivalents in Codex and Cursor perform the open; `Stop`/`SessionEnd`
  perform the close. The existing `UserPromptSubmit` hook keeps injecting
  routing context, now including the already-open `sessionUuid`.
- **The open is code, not prose.** The hook script itself reads the Git
  origin, calls `resolve_project`, and calls `open_session` with a
  machine-generated placeholder intent (for example, `Session opened
  automatically; intent pending`), the current branch, and the host thread id
  as `lineageKey`. Wrong-parameter failures become structurally impossible;
  the injected context then tells the model to *update* the intent when
  substantive work begins rather than to open anything.
- **Transport.** The hook invokes the installed `recall-mcp-bridge` helper —
  the same Recall-signed binary the MCP config uses — for a single JSON-RPC
  exchange over the local socket. Host attestation is unchanged: the hook
  runs as a child of the agent process, so bounded signed-ancestry resolution
  still lands on Claude Code, Codex, or Cursor, and an unknown host still
  fails closed. No tokens exist on this path today and none are added.
- **The close is idempotent.** The stop hook closes with a generic outcome
  only when the model has not already closed; `close_session`'s existing
  idempotent seal semantics make the race safe — a model close wins and the
  hook's close replays or no-ops. An interrupted session (crash, kill) is
  still caught by the existing ABANDONED sweep.

## The noise question (open)

Deterministic open means trivial question-answering sessions appear on Now,
which v5 deliberately avoids ("Trivial question-answering does not open a
session"). Options:

- **A. Open always; discard empties.** Open every session; at close,
  automatically discard (or de-emphasize) sessions that saw no entries and no
  model-updated intent, and never emit a day card for them.
- **B. Defer the open** until the harness signals real work (first tool use
  or file edit) where hooks expose such a signal. Weaker guarantee, less
  server support needed.
- **C. Hook guarantees only the close** and a liveness marker; the open stays
  model-initiated. Smallest change, does not fix the incident class.

Recommendation: **A**, contingent on the app/server support below. The
dashboard noise objection dissolves if an untouched automatic session leaves
no durable trace.

## Recall app and server support needed

- **Intent updates.** Today `intent` is set only at open. Either an
  `update_session` write or a late-open equivalent is required so the
  placeholder intent can become a useful one.
- **Automatic-session marking.** A `sessionKind: automatic` flag (or
  equivalent) so Now can render model-confirmed sessions and untouched
  automatic ones differently, and so empty automatic sessions can be
  discarded at close without violating the append-only ledger.

## Failure modes

- Helper missing or too old: the hook no-ops and the injected context falls
  back to the current v5 model-initiated protocol. Never a hard failure.
- The hook must never block or break the user's prompt: same catch-all and
  bounded-timeout posture as `journal-context.mjs`, with a short budget on
  the socket exchange.
- Unattested or denied host, signed-out app, blocked workspace: the open
  fails exactly as a model-initiated open would; the first-reply
  failure-report rule still applies to the injected context.

## Rollout sketch

1. Ship `update_session` (or late-open) and automatic-session marking in the
   Recall app and server.
2. Ship the lifecycle hooks behind a new config version, off by default;
   dogfood on one machine.
3. Default the config on once the noise handling proves out; keep the v5
   model-initiated path as the documented fallback for hosts without
   session-start hooks.
