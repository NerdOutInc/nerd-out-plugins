# Recall token usage optimization plan

Updated plan, September 6, 2026. Plan only; no runtime or configuration change is part of this document. It supersedes the September 5 Codex plan and was written against `recall-plugins` main `5db9ed0` (plugin 0.38.0) and `recall-app` main `3674131e` (catalog generation 7, 39 tools). Every size below is a UTF-8 byte count measured on this machine today; tokens are roughly bytes divided by four for English prose. None of it is billed usage.

The goal is unchanged: spend fewer tokens on remembering work while keeping decisions, blockers, interruptions, attribution, evidence, and recovery intact.

## Summary

1. The biggest cost is cadence, not size. The journal hook injects about 4 KB on every `UserPromptSubmit`, and Claude Code and Codex both keep that text in the transcript, so a 10-prompt session carries 40 KB of hook text and a 25-prompt session carries 100 KB. That is 35% and 58% of everything Recall puts in context for those sessions. Both hosts support a `SessionStart` hook that re-fires after compaction, so the full context can be delivered once per session and again after each compaction, with a reminder of a few hundred bytes per prompt.
2. Codex's skill split shipped (plugin PR #63), but the ordinary v5/v7 bundle is still 22 KB, and 34 KB with efforts. The dispatcher is small; the references are not.
3. The app has not started the compact-response work. `append_entry` still echoes the full entry, `open_session` returns full projections of every other ACTIVE session, `get_project_context` still serves eight entries whole up to 4 KiB each, and there is still no `read_entry`.
4. Routing pollution is a token cost. Both of Brian's journal configs are version 5 with the Recall Project as the default, so unrelated Codex sessions land in this Project: in today's context read, three of eight entries and one of two ACTIVE sessions were shirt-design work. A version 7 config with a separate global Project removes that from every future read.

Ship the plugin-only slice first. It needs no app release, and the model below puts it at a 35% to 64% reduction depending on session length, before any app change.

## What changed since the Codex plan

| Codex plan item | Status on September 6 |
| --- | --- |
| Split the 66 KB journal skill by workflow | Done in #63. `SKILL.md` is a 4.5 KB dispatcher routing to per-mode references. The ordinary v5/v7 load is 22.3 KB (dispatcher, `structured-writer.md`, `project-context.md`); 33.7 KB with `efforts.md`. Codex's 12 KiB budget is not met. |
| Shorten the per-prompt hook | Not done. The hook grew from 3,674 to 4,066 bytes (malformed-call rule from #61, version 7 upgrade offer from #65). |
| Byte budgets in CI | Not done. The only size assertion is that the upgrade offer stays under 420 characters. |
| Compact MCP responses, `read_entry`, receipt-only append | Not started in the app. Generation 7 added `read_effort`, `bind_effort`, and `resume_milestone` instead. |
| Catalog trim | Not done. 39 tools, 64,938 bytes (descriptions 11,541; schemas 53,397). |
| Helper aggregation | Not done and lower priority; see Slice A7. |
| Delta context read | Shipped earlier and preserved. Its reach is narrow: a fresh conversation is a fresh lineage with no predecessor, so today's read, like Codex's sample, was unanchored. |

The previous session's own follow-ups (September 5, "Assessed what agent integration still needs") already ask for a smaller per-prompt payload and for milestone-recovery guidance to leave the common path. This plan is the concrete form of those.

## Measured baseline

| Surface | Bytes | When it matters |
| --- | ---: | --- |
| Per-prompt hook, Claude Code, v5 repository route (live, this directory) | 4,066 | Every `UserPromptSubmit`, including background-task notification turns. Runs in about 80 ms. |
| Hook goldens, v5 and v7 structured routes | 3,674 to 4,378 | Per prompt on Claude Code and Codex; once per session on Cursor. |
| `recall-journal/SKILL.md` dispatcher | 4,538 | Once when the skill loads. |
| `structured-writer.md` | 13,708 | Every v5/v7 load. |
| `project-context.md` | 4,069 | Linked from the writer reference; loaded with it. |
| `efforts.md` | 11,379 | Named multi-session work. About half of it is milestone recovery. |
| `configuration.md` | 40,986 | Setup, upgrade, repair only. The version 7 upgrade offer now routes users here. |
| `legacy-notes.md` plus its link to `configuration.md` | 74,627 | Version 1 and 2 configs only. |
| `recall/SKILL.md` (general notes skill) | 24,677 | Explicit note work only; not on the journaling path. |
| Skill descriptions in every session's system prompt | 650 + 312 + 102 | Always on, in every project, whether or not journaling is configured. |
| Tool catalog, generation 7 | 64,938 | Deferred in Claude Code and Codex; only names load until a schema is fetched. |
| Evidence schema inside 6 tools | 3,422 each, 20,532 total | 32% of the catalog. Each copy carries a 2,019-byte `anyOf` and an 888-byte flattened `properties` block. |
| Core five journaling schemas fetched per session | 16,449 | `resolve_project`, `open_session`, `get_project_context`, `append_entry`, `close_session`. |
| Ten journaling schemas with efforts | 28,562 | Adds `record_milestone`, `open_effort`, `list_efforts`, `read_effort`, `bind_effort`. |
| `open_session` response (live) | about 2,400 | About 800 per other ACTIVE session, each a full projection with empty `outcome`, `runningSummary`, and `followUps`. |
| `get_project_context`, unanchored, this Project | about 23,000 | Same shape as Codex's 22,570-byte sample: entries about 56%, closed sessions about 23%, recent notes about 12%. Cap is 32 KiB; priority entries are served whole up to 4 KiB each. |
| `append_entry` response | 1,000 to 2,500 | Echoes the projected entry, including its prose. |
| `close_session` response | about 500 | Already a compact receipt. |

The catalog is not a per-prompt cost on either host. Claude Code defers MCP schemas by default (`ENABLE_TOOL_SEARCH`) and loads names only; Codex exposes Recall through deferred discovery as well. The per-session schema cost is the set an agent actually fetches, which is why the evidence duplication matters more than the total.

## Cadence: the finding the Codex plan missed

Claude Code adds a `UserPromptSubmit` hook's `additionalContext` to the transcript on every prompt and does not deduplicate it (hooks reference: text from `additionalContext` is kept from every hook). During this session the hook text also arrived on a background-agent completion notification, so notification turns count too. Prompt caching bills the older copies at the cached rate, but each copy is written at full price once, every copy occupies context for the rest of the session, and the accumulated text brings compaction forward.

Hook share of Recall context today, by session length (3 entries, 2 other active sessions):

| Prompts | Hook bytes | All Recall bytes | Hook share |
| ---: | ---: | ---: | ---: |
| 1 | 4,066 | 78,700 | 5% |
| 5 | 20,330 | 95,000 | 21% |
| 10 | 40,660 | 115,400 | 35% |
| 25 | 101,650 | 176,300 | 58% |
| 50 | 203,300 | 278,000 | 73% |

Host facts that make the fix possible, verified against each host's documentation on September 6:

- Claude Code: `SessionStart` fires with matcher values `startup`, `resume`, `clear`, `compact`, and `fork`, receives `session_id` and `cwd`, and its output is added to context. After compaction the `compact` matcher fires again before the next model request. `UserPromptSubmit` carries `session_id` and `cwd` but no prompt number.
- Codex: supports `SessionStart` with `source` values `startup`, `resume`, `clear`, and `compact`, plus `UserPromptSubmit`, `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop`. Its docs state that after Codex compacts a root session, `SessionStart` hooks matching `source: "compact"` run before the next model request. Both events accept `additionalContext`.
- Cursor: only `sessionStart` can return `additional_context`; `beforeSubmitPrompt` cannot, and `preCompact` is observational. Cursor therefore already runs at the right cadence and only benefits from a smaller once-per-session text.

## Cost model

Bytes for one Claude Code journaling session under the v5/v7 writer, from the measurements above. "Plugin only" is Slice A; "with app" adds Slice B. The assumptions are listed after the table; treat the results as estimates to validate with the benchmark in A8, not as measured savings.

| Scenario | Today | Plugin only | With app | Cut, plugin | Cut, both |
| --- | ---: | ---: | ---: | ---: | ---: |
| Short task: 3 prompts, 2 entries | 82 KB | 54 KB | 45 KB | 35% | 45% |
| Typical task: 10 prompts, 3 entries | 113 KB | 57 KB | 48 KB | 49% | 58% |
| Long session: 25 prompts, 4 entries | 175 KB | 63 KB | 52 KB | 64% | 70% |
| Effort session: 10 prompts, 3 milestones | 136 KB | 71 KB | 61 KB | 48% | 55% |

Assumptions: SessionStart context 3,000 bytes delivered twice (startup and one compaction), per-prompt reminder 250 bytes; skill bundle 12,000 bytes ordinary and 16,500 with efforts; schemas 12,500 and 22,000 after the evidence and description trims; context read 15,600 bytes with plugin-side limits and 9,000 with the app's compact profile; `open_session` other-session rows 250 bytes each; append receipts 350 bytes with the app change; entry arguments 700 bytes under the prose targets. Typical-task breakdown today: hook 35%, responses 26%, skill 19%, schemas 14%, arguments 5%.

## Slice A: plugin only, ship first

**A1. Move the protocol to `SessionStart` and shrink the per-prompt hook to a reminder.** Register `SessionStart` in `hooks/hooks.json` for Claude Code and Codex (no matcher; branch on the input's `source` inside `journal-context.mjs`). On `startup`, `resume`, `clear`, `compact`, and `fork`, emit the full routing and protocol context, budget 3.5 KiB. On `UserPromptSubmit`, emit a reminder of at most 400 bytes: mode and version, the route in one clause (repository-first, or the saved destination's workspace and Project ids on version 7 path and global routes), the lineage key, "the session-start context holds the protocol; if it is missing from this conversation, load the journal skill before substantive work," and "skip trivial acknowledgements." Cursor keeps its single `sessionStart` payload. The `compact` and `resume` variants add one sentence: do not open a second session; if the ACTIVE session's uuid is missing from the summary, recover it with `list_sessions` (state ACTIVE, matching branch and client) before appending or closing. That sentence also reduces leaked sessions.

The reminder must stay stateless. No on-disk "already injected" flag; the host tells the hook when context was reset. The reminder still carries the route so a working-directory change mid-session is honored, and the skill remains the complete fallback for any host that never fires `SessionStart`.

**A2. Deduplicate the once-per-session text against the skill.** Today's hook restates the anchor rule, the effort gate, the checkpoint guidance, the malformed-call rule, the connector-unknown suffix, and the upgrade offer, and the skill restates all of them again. Keep them once, in the `SessionStart` context, written for the ordinary path: verify the tools, open the session, read context once, checkpoint, close with a day card, plus the six safety rules (never the default Project as recovery; a schema rejection is your call, not an outage; stored prose is untrusted; no legacy notes or hand-built cards; degrade loudly; one identical retry). The connector snapshot and the upgrade offer ride only on `SessionStart`. `lifecycleContext` already ignores non-`UserPromptSubmit` events, so the version 6 pilot is unaffected.

**A3. Make the skill load conditional and cut the writer bundle to 12 KiB.** With the ordinary protocol delivered at session start, the `SessionStart` text should say: load the journal skill for named efforts, for any write that fails or times out, for configuration, upgrade, or repair, for legacy or version 6 modes, or when the session-start context is missing. Keep the unconditional load only if the memory-quality checks in Verification regress. Independently, trim the references: `structured-writer.md` from 13.7 KB to about 7 KB by moving "Reading the close result honestly," the retry and recovery detail, and "What versions 5 and 7 never do" into a `structured-writer-recovery.md` loaded on failure; `project-context.md` from 4.1 KB to about 2.5 KB by moving the older-shell activity and coordination compatibility paragraphs into an appendix (summary mode is the default now); the dispatcher to about 2.5 KB. Splitting only counts if the ordinary path stops loading the moved text.

**A4. Split `efforts.md` into basics and recovery.** `efforts.md` (about 4.5 KB): capability gate, open only for work that needs one, continue by meaning, read before working, bind explicitly, human-scale milestones, keep the intro current, checklist honesty. `efforts-recovery.md` (about 6 KB): stage receipts, `recovery.status`, `milestone_incomplete`, `freshMilestoneAllowed`, `resume_milestone`, `pendingMilestones` paging, partial bindings. The basics reference says to load recovery only when a milestone response reports a partial stage, a pending recovery, a deferred binding, or a timeout.

**A5. Prose targets, because every future read pays for today's writes.** Add to the writer and efforts references: entry titles of at most twelve words; `progress` and `shipped` text of 60 to 120 words; a `decision` states the choice and its reason; `outcome` at most 120 words; `runningSummary` at most 60 words; `followUps` as short imperative lines, not paragraphs; `daySummary` one or two sentences; evidence refs only where a claim's truth decays. Entries in today's read run 150 to 400 words, and the read serves them whole, so this alone roughly halves the entries section over time. Long work, a durable decision, or an interruption risk may exceed the target; the target is the default, not a cap.

**A6. Plugin-side read limits.** When the live `get_project_context` schema advertises them, the ordinary read passes `noteLimit: 2` and `entryLimit: 6` and keeps the existing anchor rules. Recent note titles cost about 350 bytes each and rarely inform coding work; decisions, blockers, shipped, and summary entries still come first and whole. Measure the effect on this Project before choosing the numbers; the model above assumes about 7 KB saved.

**A7. Helpers.** In Claude Code, `UserPromptSubmit` and `SessionStart` do not fire inside subagents, so the multiplied-startup scenario in the Codex plan has not been observed there; Codex exposes `SubagentStart`, so verify the same. Add one sentence to the writer reference: a helper spawned by a session that already journals returns findings to its parent and never opens its own session; independently owned work and explicit handoffs still get their own. No feature work beyond that.

**A8. Budgets and a measurement script in CI.** Add `tests/recall-token-budgets.test.mjs` asserting byte bounds on every hook golden by event, on each mode bundle through `readModeGuidanceSync`, and on the skill descriptions; add `scripts/measure-context-cost.mjs` that prints the baseline table above (hook by event and route, bundle by mode, schemas by tool subset from a checked-in catalog fixture, and the cost model). Bytes only in CI; a tokenizer estimate can be an optional local flag. Regenerate the fourteen hook goldens once and keep them golden.

**A9. Small always-on trims.** Cut the `recall-journal` description from 650 bytes to about 300 (the hook names the skill, so the description need not enumerate triggers) and the doctor description to about 200. Drop the per-prompt upgrade offer once Brian's own configs move to version 7 (Slice C1); until then it rides on `SessionStart` only.

Deliverables: hook and `hooks.json` changes, reference rewrites, regenerated goldens, budget tests, README and changelog, plugin 0.39.0.

## Slice B: app changes, catalog generation 8

Advertise these through a new catalog generation and the typed bridge contract, with the Swift catalog, the Windows `tool-catalog.json`, and the web handlers in parity; never change shapes for a shell hosting newer web code silently. Plugin guidance discovers each from the live schema and response, never from a version.

**B1. `append_entry` returns a receipt.** `entryUuid`, `sessionUuid`, `idempotencyKey`, `syncStatus`, `authoredAt`, and the recorded `evidence` and `supersedes` (the general skill tells agents to verify that echo), but no `text`, `refs`, `href`, or actor envelope. Budget 600 bytes. `close_session` stays as it is.

**B2. Compact `otherActiveSessions` and `unfinishedPredecessors` on `open_session`.** Per row: `sessionUuid`, `clientLabel`, `branch`, `intent`, `startedAt`, `lastActivityAt`, `advisoryStale`. Drop the per-row `href`, `workspaceId`, `projectUuid`, `transport`, `actor`, and the always-empty ACTIVE-state `outcome`, `runningSummary`, and `followUps`. Keep `previousSession` whole; it is the continuity the read is for. Consider omitting sessions that have been `advisoryStale` for more than a day, or shortening the idle-to-ABANDONED sweep, since every leaked session costs about 1.5 KB across the open and the read for every later session in the Project.

**B3. `get_project_context` compact profile plus `read_entry`.** Add `read_entry` (by `entryUuid`, full text, refs, evidence, supersedes) so the context read can stop serving bodies whole. Then, under a `profile: "journal"` or equivalent negotiated input: hoist `workspaceId`, `projectUuid`, and the Project `href` to the envelope and drop them from rows; keep per-row UUIDs and distinct actor attribution; cap entry text at about 600 characters with `textTruncated` and a `read_entry` pointer; cap closed-session `outcome` at about 400 characters with `read_session` as the full path; omit `recentNotes` unless requested; omit empty arrays, null cursors, and false `*Truncated` flags under a documented "absent means empty or false" rule for that generation only, while keeping every section's `available` and `truncated`. Target 8 KiB on this Project with explicit omissions and continuation. Do not truncate a CLOSED predecessor's own content in `open_session`, and do not introduce a new cursor that reuses "last call time."

**B4. Evidence schema and descriptions.** The flattened `properties` block exists because `McpToolInputValidator` ignores `anyOf`. Teach the native validator the `anyOf` subset (or validate evidence in the web handler only) and drop the flattened copy: 888 bytes from each of six tools, 5.3 KB from the catalog, 1.8 KB from an ordinary session's fetched schemas. Shorten the four longest descriptions (`record_milestone` 1,184, `close_session` 1,046, `open_effort` 765, `append_entry` 611 bytes) to what prevents mistakes. Keep the discriminated union, required fields, and validators. Skip tool profiles and dynamic tool lists; deferred loading already removes most of the catalog cost, and host rediscovery is unproven.

**B5. Encoding.** Responses reach the agent with escaped slashes (`https:\/\/`), which JavaScript does not emit, so a native encoder re-serializes the text. Use non-escaping output if it is Swift's `JSONEncoder`. A few hundred bytes per read, free.

## Slice C: routing hygiene and memory quality

**C1. Upgrade both journal configs to version 7 with a global Project that is not Recall.** This is already a follow-up from September 5; it is also the cheapest context-read saving available, because unrelated sessions and entries stop competing for the eight entry slots and the 32 KiB budget. Consider an app-side repository-binding scope on `get_project_context` for Projects with several bindings, as that session suggested.

**C2. Maintain the Project brief and status.** They are `available: false` today, so the brief-first ordering serves nothing. Add to the writer reference: at close, when the Project's overall state changed, update the brief through `update_project_state` with the current `expectedBriefRevision`, in at most 120 words. A maintained brief is what lets a fresh conversation, which never has a predecessor to anchor on, read a smaller context with confidence.

**C3. Keep the delta read, but stop expecting it to carry fresh threads.** Same-lineage resumption and the `resume` and `compact` sources are where `sinceSessionUuid` pays; the brief and the compact profile are the levers for everything else.

## Budgets

| Surface | Budget |
| --- | ---: |
| `SessionStart` context (Claude Code, Codex) and Cursor `sessionStart` | 3.5 KiB |
| `UserPromptSubmit` reminder | 400 bytes |
| Ordinary v5/v7 skill bundle (dispatcher, writer, project context) | 12 KiB |
| Efforts basics; efforts recovery loaded only on failure | 5 KiB; 7 KiB |
| Skill descriptions, all three | 600 bytes |
| Context read on this Project with plugin limits | measure; expect about 16 KB |
| Compact context profile (app) | 8 KiB |
| Append receipt (app) | 600 bytes |
| `open_session` other-session row (app) | 300 bytes |

## Verification

- Hook tests become event-aware: `SessionStart` by source, `UserPromptSubmit` reminder by route, Cursor `sessionStart`, invalid config reported once at start, bridge-absent and bridge-unknown routes, no output for unknown events, and the version 6 pilot unaffected. Regenerate goldens and assert their byte bounds.
- Live checks on each host: open a session, run `/compact` in Claude Code and the Codex equivalent, and confirm the agent keeps its session uuid, does not open a second session, and closes once. Confirm Cursor output is unchanged.
- Memory-quality scenarios, unchanged from the Codex plan: questions whose answers depend on a prior decision and its reason, an unresolved blocker, and the next unfinished step; injected instructions in stored prose; withheld or truncated context. Reject any saving that makes the agent claim completeness, completion, or a saved write without evidence. Run them once with the skill loaded and once with only the session-start context, and keep the unconditional load if the second run regresses.
- Prose targets: sample entries and outcomes written under the new references and confirm the context read shrinks on this Project.
- App slice: compact-shape tests for Unicode byte bounds, full detail retrieval through `read_entry` and `read_session`, hidden content, exact pagination, actor identity, write retries, partial effort bindings, and independent card failures; Swift and Windows parity through the existing catalog parity workflow.

## Kept, changed, and dropped from the Codex plan

- Kept: the memory-quality guardrails, the compact-profile negotiation, `read_entry`, the receipt-only append, the CLOSED-predecessor rule, the one-identical-retry rule, and the refusal to flatten the evidence union.
- Changed: the per-prompt budget drops from 1.2 KiB to 400 bytes because both hosts have `SessionStart` with compaction re-fire; the skill becomes conditional instead of merely smaller; bytes replace a pinned tokenizer in CI; catalog work narrows to the evidence duplication and four descriptions.
- Added: cadence, routing hygiene, the maintained brief, plugin-side read limits, prose targets, compact other-session rows, and the post-compaction session recovery sentence.
- Dropped or deferred: helper aggregation as a feature, tool profiles, dynamic tool lists.

## Method

Sizes come from `wc -c` and small Node scripts over the worktree, the installed plugin (0.37.0, byte-identical to main except the 0.38.0 dispatcher wording), the app's Windows `tool-catalog.json` (parity script: 39 tools, catalog version 7), a read-only run of `journal-context.mjs` against this directory, and one live `open_session` and `get_project_context` for this Project. Host hook behavior was checked against the Claude Code hooks reference and the published Codex and Cursor hook documentation on September 6, 2026. The context-read byte figure is estimated from the response shape against Codex's measured sample; the benchmark in A8 replaces it with a measured number.
