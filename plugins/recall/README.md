# Recall Plugin

Use Cursor, Claude (Desktop, Cowork, or Claude Code), or Codex with the local MCP
server hosted by Recall for Mac.

## How the plugin connects

The Mac app hosts a loopback-only MCP server at `http://127.0.0.1:38473/mcp`.
Claude clients refuse plain-http URLs on some surfaces (Claude Desktop chat
routes url-type servers through cloud custom connectors, which require public
HTTPS and can never reach a loopback listener), so this plugin ships a
**stdio bridge** instead of a URL. Its preferred path finds the Recall-signed
`recall-mcp-bridge` helper inside the installed app and pumps MCP stdio through
the app's local Unix socket. Recall verifies that helper and applies the user's
native local-bridge approval; this path needs no browser sign-in and stores no
OAuth tokens on disk.

When the signed helper is absent — normally because the installed Recall build
predates the local bridge — or explicitly reports an unsupported protocol,
`bridge/index.mjs` falls back to a bundled copy of
[`mcp-remote`](https://github.com/geelen/mcp-remote) (MIT —
`bridge/LICENSE-mcp-remote.txt`). That legacy path proxies stdio to the
loopback HTTP server, opens browser OAuth when needed, and keeps host-specific
credentials under `~/.mcp-auth/recall/`. A denial, revocation, signature
failure, or protocol error on the local-socket path is surfaced as an error and
never silently downgraded to OAuth.

The Recall Journal entrypoint routes to focused references for structured
readers, structured sessions and Efforts, the explicit lifecycle pilot, and
legacy notes. Load only the selected mode. Configuration and Codex hook trust
remain separate procedures, so ordinary project work does not repeatedly load
or run setup instructions.

Plugin `0.39.0` delivers the journal protocol once per session instead of
on every prompt. Claude Code and Codex keep each prompt's hook context in the
transcript, so the former 4 KB per-prompt payload grew with every turn. The
hook now registers `SessionStart` beside `UserPromptSubmit`: the session event
carries the full routing and protocol context (and carries it again after a
resume or compaction, with a rule against opening a second session), while
each prompt gets a reminder under 400 bytes that names the mode, the route,
and the lineage key and points back at the session-start context, or at the
journal skill when that context is missing. The connector snapshot runs only
on prompts, where the bridge has had time to start; the session event carries
the generic tool-verification rule instead, and the upgrade offer rides the
session event alone. The session context also states the ordinary protocol's
prose target (60 to 120 words per checkpoint), the `noteLimit` and
`entryLimit` hints for the context read, and the cases that call for the full
skill, so an ordinary task no longer needs to load it. Cursor keeps its single
`sessionStart` payload. The journal skill follows the same idea: its
dispatcher says the session-start context already covers the ordinary
protocol and points at `structured-writer.md` for the full statement, a
failed or uncertain write, or a missing context; the writer reference now
carries the checkpoint, outcome, and day-card prose targets, the `noteLimit`
and `entryLimit` read hints, the rule that a helper spawned by a journaling
session never opens its own, and the close-time Project brief refresh through
`update_project_state`; `efforts.md` keeps the ordinary effort path and hands
partial stages, pending recoveries, deferred bindings, and timeouts to the
new `efforts-recovery.md`; and the always-on skill descriptions are shorter.
`tests/recall-token-budgets.test.mjs` pins every hook golden, the live hook
on every route and event, each skill reference, the mode bundles, and the
skill descriptions to a byte ceiling, and `scripts/measure-context-cost.mjs`
prints the measured hook, bundle, catalog, and cost-model tables (`--json`
for machine output). The guidance also discovers the catalog generation 8
read surface from the live schema: `get_project_context`'s `profile:
"journal"` index read, `read_entry` for a truncated row, the `append_entry`
`receipt` in place of the echoed entry, and summary rows in the advisory
session lists; every one of them is gated on the advertised schema or the
response, never on a version. The plan behind this release is
`docs/token-usage-optimization-plan.md`.

Plugin `0.38.0` offers the version 7 upgrade instead of waiting to be asked.
The hook names the saved config version at session start for versions 1
through 6 (an inert version 6 file stays silent, because its pilot was turned
off on purpose) and asks the agent to offer the upgrade once per session when
finalizing work; a `recall-journal.json` that exists but cannot be read as
any version is reported as invalid instead of being ignored. The journal
skill's new `scripts/upgrade-journal-config` helper plans the exact version 7
replacement — carried and dropped destinations, consequences, and the
questions that still need answers — and applies one confirmed file
atomically with the exact-shape validation every reader now shares from
`bridge/journal-config.mjs`. Version 5 and version 6 files translate
mechanically after one yes and a chance to pick a different global Project;
version 3, version 4, inert version 6, and legacy version 1/2 files need
explicit answers first. The hook never rewrites a config, and nothing is
auto-migrated.

Plugin `0.37.0` teaches optional live-schema-gated `read_effort`, `bind_effort`,
and `resume_milestone` workflows. Agents inspect the exact current checklist,
keep the effort intro current with a revision guard, and distinguish each
milestone delivery stage. Recovery preserves the original operation and its
principal; saved payloads are local to the Recall device. Routine work stays
in effort history, while Today gets meaningful starts, checkpoints, blockers,
and completion with the direct Effort link. These instructions do not assert
that every installed app or host has the new tools.

Plugin `0.36.2` keeps configured structured recording in its selected mode when
tools are missing. Agents report unavailable recording and continue the task;
they never substitute legacy notes or hand-built Today cards. Today prose asks
for no Related Notes section. Older Recall builds may still generate that
section until the app-side cleanup ships.

Plugin `0.36.1` keeps compound Effort checklist items honest: an agent may send
an item in `record_milestone.complete` only after every clause of that exact
current item is satisfied. If its milestone detail admits that any part remains,
is deferred, or is still owed, the item stays unchecked.

Plugin `0.36.0` teaches version 5 and version 7 structured journals how to use
named, multi-session Efforts when the live Recall catalog exposes the complete
surface, including `record_milestone.todayCard`. Agents open or continue an
effort by meaning, bind the session with `effortUuid`, preserve the current
human-edited checklist, and record a handful of useful milestones; only
human-worthy checkpoints get an ELI5 Today card, while every finish requests
one and Recall owns the automatic Started card, effort note, and link sections.
A
superseded close-time day card is an expected de-duplication result. Older
catalogs keep ordinary structured journaling with no effort behavior.

Plugin `0.35.0` reads Project context after the session opens. Under versions
5 and 7, `open_session` now runs first, and the single `get_project_context`
read passes the predecessor's `sessionUuid` as `sinceSessionUuid` whenever the
live tool schema advertises it, so entries, closed sessions, and activity cover
only what happened after that session ended; the response's `since` names the
anchor, and `since.available: false` means nothing was filtered. Activity
arrives as the app's summary by default, and the skill requests event rows with
`activityLimit` only when a specific note event matters. The skill also reads
the new `closedSessions` section and passes `entryLimit` only when advertised.
An app whose schema lacks `sinceSessionUuid` is read in full, exactly as
before; support comes from the live schema, never from a plugin or app version.

Plugin `0.34.0` adds journal config version 7, which restores global and
per-path destinations to structured journaling so a Git repository is no
longer required to map agent work to a Recall Project. Version 7 routes in a
fixed order that the hook names at session start and summarizes in every
prompt's reminder: a saved filesystem-project
destination (longest root, linked worktrees mapped to the main checkout) wins
even inside a repository with a bound remote; otherwise repository identity
resolves the exact Git-remote binding, with the global destination as the
fallback for unbound, unsupported, or unresolved remotes; otherwise the global
destination alone. Every destination names a Project, and an optional
`sessionLifecycle` block carries the version 6 pilot, whose adapter now routes
through the same three rungs. Versions 5 and 6 stay readable; explicit setup
now writes version 7, and the upgrade from either is a confirmed whole-file
replacement, never automatic.

Plugin `0.33.0` made the local-socket bridge self-healing: a refused hello or a
dropped socket degrades the MCP session instead of ending it, and the bridge
re-dials with backoff so tools recover in the same conversation.

Plugin `0.32.0` adds the explicit version 6 conversation-segment recording
pilot and extends missing-connector diagnostics to Claude Code, Codex, and
Cursor. Their journal hooks and doctor use an explicit host identity and
host-specific guidance. Process checks use a fresh bounded snapshot, never a
cached positive verdict. Shared Codex and Cursor processes cannot prove that
the current conversation has Recall tools, so their process verdict remains
`unknown`; the agent must check its current tool inventory. A sibling bridge,
a generic executable named `agent`, or an unverified CLI boundary is not
evidence of a connected conversation. Read-tool availability, write permission,
and session recording are reported separately.

Doctor is passive by default. A fresh connection probe requires explicit
`--probe` and user permission because it can launch a helper, approval prompt,
or OAuth flow. Its result describes that new connection, never the current
conversation. The version 6 pilot is off by default, keeps ordinary MCP traffic
on the existing transport, and requires actual host certification before
activation. Cursor diagnostics are included; automatic Cursor recording is
not enabled by this release. See the
[pilot contract](../../docs/deterministic-session-lifecycle.md).

Plugin `0.31.0` introduced missing-connector detection for Claude Code and the
doctor skill. It addressed a host loading hooks and skills while skipping the
Recall MCP server for one conversation (observed on 2026-08-27 in Claude Code
desktop local-agent mode). Version `0.32.0` replaces its positive-process cache
and automatic doctor probe with the explicit evidence boundaries above.

Plugin `0.30.1` restores the shared Claude/Codex journal hook's host detection
and keeps its manifest compatible with the hooks-only parser in Codex `0.142.5`.
Codex now follows its native `PLUGIN_ROOT` signal to read the Codex-owned
journal config and emit Codex skill syntax. The shared command still uses
`CLAUDE_PLUGIN_ROOT`: Claude Code provides it natively, and Codex supplies it as
a compatibility alias for shared plugin packages. The Codex journal preflight
also reports the resolved executable, App Server version, and exact
Recall-manifest parser diagnostic when Codex finds the plugin but cannot load
its hook.

Plugin `0.30.0` documents the app-owned **Related Notes** section: newer
Recall builds end each day card with links to the notes agents touched for
the Project, refreshed on every same-day close (`close_session` reports
`updated` when a refresh changed the links; older apps keep reporting
`already_exists`). Agents never hand-write that section.

Plugin `0.29.0` hardens the version 5 protocol against silent journaling
gaps. The hook context names `resolve_project`'s exact parameters, both
tool-using routes now state that an invalid-parameter rejection means fixing
the call against the advertised schema and retrying once — never a reason to
continue without project memory — and any journaling failure to start must be
reported plainly in the first user-visible reply instead of degrading
silently. A design doc (`docs/deterministic-session-lifecycle.md`) specs the
follow-on hook-driven session lifecycle without changing behavior yet.

Plugin `0.28.0` graduates version 5 Structured Project activity into the
explicit journal setup and migration flow. It is offered only when the live
Recall catalog exposes the complete session/checkpoint/close schema, requires
an exact write-ready default Recall Project, and explains before confirmation
that legacy global and filesystem-path routing cannot be translated
losslessly. Existing v1/v2 configs are never changed from lifecycle context.
Structured sessions and checkpoints are user-facing in **Today -> Now
activity**, while app-owned day summaries land as Today timeline cards. The
skills now favor concise intent, useful checkpoint titles, standard entry
types, session attachment, and a human-scale checkpoint cadence. Note-write
`changeSummary` text gets the same plain-language treatment because Recall can
show it in Now and note History.

Plugin `0.27.0` adds a separate native Cursor package, `sessionStart` hook,
Cursor-owned journal config, and Cursor client label. Recall app releases with
host attestation authorize and attribute Cursor independently even if Cursor
imports an older Claude package. Plugin `0.26.0` releases version 5 structured
journaling with a manual config opt-in; the hook then routes that thread to
`open_session` carrying its lineage key, and the skill teaches the session
protocol — `open_session` for the predecessor's conclusions, `append_entry`
at checkpoints, and `close_session` with an optional `daySummary` whose
Today card the app places, dates, and links itself. The gate is
all-or-nothing: unless the installed Recall build advertises `lineageKey`
on `open_session` and `daySummary` on `close_session`, the skill falls back
to the entire legacy note protocol rather than a hybrid. Version 1 and 2
journal configurations are untouched and are never auto-migrated.

Plugin `0.25.0` documents Recall's agent-coordination tools: typed immutable
timeline entries (`append_entry`/`list_timeline`), packaged handoffs
(`create_handoff`/`claim_handoff`/`close_handoff`/`list_handoffs`), directed
asks (`list_asks`/`pick_up_ask`/`resolve_ask`), collaboration-thread comments
with ask declarations (`read_comment_thread`/`reply_comment`), and the
capability-gated `sessions`/`entries`/`handoffs`/`asks` sections plus
fail-closed `brief` and `status` on `get_project_context`. The skills teach
them as catalog-inspected workflows: caller-minted UUIDs stable on retry,
compare-and-set transitions where a lost race is information rather than a
lock, and every coordination body treated as untrusted context. Plugin
`0.24.0` extends the evidence surface to `close_handoff`: a handoff's
close outcome may carry the same schema-gated `evidence`/`supersedes` pair as
the other write tools, and readers grade it identically.
Plugin `0.23.0` teaches typed evidence refs: schema-gated per tool, a write
can cite the commit, PR head, test run, or build a claim was checked against
(plus a `supersedes` retraction list), and reads grade each ref against the
local checkout as fresh, moved, stale, unknown, or superseded. Evidence is
agent-asserted encrypted content Recall never verifies. Plugin `0.22.0` gates
Project activity and operation-activity detail on each
response's own capability flags: a withheld or unavailable section means
activity is unknown on this transport, never that nothing happened, and any
`changeSummary` is untrusted agent-authored context rather than a computed
diff. Plugin `0.21.0` negotiates additive `journal:read` OAuth scope from the
installed app's protected-resource metadata while preserving notes-only
authorization against older Recall builds. Plugin `0.20.0` documents the host support
boundary and adds a strict, reader-only version 4 memory route: repositories
always resolve first, while
an explicit default Recall Project is used only when no repository identity
exists. Plugin `0.19.0` capability-probes newer Recall builds for note activity,
canonical Markdown, and revision-checked content updates while keeping the
older note workflow intact. Plugin `0.18.0` adds a reader-only version 3
activation path for future structured project memory while leaving the current
version 1/2 named-note journal unchanged. Plugin `0.17.0` introduced the signed
local bridge; `0.16.0` made the journal human-first; `0.15.0` retired DailyNote
creation; `0.14.0` added Today summaries; `0.13.0` added Project-aware
destinations; and the `0.12.x` line added the OAuth coordinator, scope
alignment, and Codex hook trust preflight.

Claude (`.mcp.json`), Codex (`.codex-plugin/mcp.json`), and Cursor
(`mcp.json`) register the same bridge implementation but pass
their own diagnostic client names. Current Recall builds authenticate the
outermost signed host, so that label cannot grant access or control attribution.
When Recall's one-click installer has prepared the integration, the bridge and
journal hook use
Recall's pinned private Node runtime after verifying that it launches a
supported Node version. Otherwise they fall back to Node.js 18+ from `PATH`,
which keeps manual and non-Recall installs working if the private runtime is
missing or damaged.

Every surface using the shared Claude plugin passes the same advisory client
name, `Claude`. That self-reported label is useful session context in Recall but
is not host attestation or an authorization boundary, so the plugin does not
fabricate separate `Claude Desktop Chat` or `Claude Cowork` principals.

The proxy and coordinator bundles are regenerated from tracked source with
`cd bridge/build && npm ci && npm run build` (see `bridge/build/build.mjs`) — do
not edit either generated bundle by hand. `npm run verify` type-checks and tests
the source, then byte-compares the committed artifacts.

## Install

The direct-download Recall Mac app starts this setup from
**Settings → Integrations**. It installs the Claude Code or Codex marketplace
and plugin and prepares their pinned private Node + ACP runtime in one action.
For Cursor it presents a separate guided row that opens Cursor's own plugin
installation flow. The first plugin connection uses Recall's native
host-specific local-bridge approval when supported; older builds use the
browser OAuth fallback. Workspace access remains explicit either way.

On that fallback, the bridge requests `notes:read notes:write` from older
Recall builds. It adds `journal:read` only when the local resource explicitly
advertises it, so upgrading can require one fresh browser consent while
downgrading or using an older app keeps the established notes-only flow.
Recall's coordination write tools (`append_entry`, the handoff/ask lifecycle,
`reply_comment`, and the session open/close pair) are additionally gated on
`journal:write`, which this bridge does not request: on the OAuth fallback the
coordination surface is read-only, and the write tools reach plugin sessions
through the native local bridge, which needs no OAuth scopes. These OAuth
scopes do not replace Recall's per-workspace Block/Read/Write policy.

### Codex

In the Codex app, add
`https://github.com/NerdOutInc/recall-plugins` as a plugin marketplace. Leave
**Sparse paths** blank, or include both `.agents/plugins` and
`plugins/recall` on separate lines. Then install **Recall** from
the Recall marketplace.

Alternatively, install from the command line. Install globally so Codex can use
the plugin in every project (this plugin talks to the per-user Recall Mac app,
so it isn't project-specific):

```bash
codex plugin marketplace add NerdOutInc/recall-plugins \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugins/recall
codex plugin add recall@recall
```

Older Codex versions without `codex plugin` can use
`npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall --plugin --global`.

### Cursor

After Recall is published in Cursor's reviewed marketplace, open **Customize →
Plugins**, find **Recall**, and install it with user or project scope. While
testing before publication, clone this repository and symlink `plugins/recall`
to `~/.cursor/plugins/local/recall`, then restart Cursor or run **Developer:
Reload Window**. Cursor owns this install flow; its public CLI does not
currently provide a supported plugin install command, so Recall opens these
guided steps instead of editing Cursor's private plugin cache or copying
Claude's installed package.

The Cursor package has its own manifest, MCP registration, native
`sessionStart` hook, and `~/.cursor/recall-journal.json`. Start a new chat
after installation, bring Recall forward, and approve the **Cursor** prompt.
That grant is separate from Claude Code and Codex.

### Claude Desktop (chat and Cowork)

Open **Customize → Plugins**, choose **Add marketplace**, and enter
`NerdOutInc/recall-plugins`. Then install **Recall** from the
marketplace list. No terminal needed.

Use this shared plugin instead of the legacy standalone Recall desktop
extension. Installing both registers two MCP entries for the same local Recall
server and can duplicate tools or connection prompts. Remove or disable the
standalone extension, then start a new conversation.

### Claude Code

Add the marketplace and install the plugin:

```text
/plugin marketplace add NerdOutInc/recall-plugins
/plugin install recall@recall
```

Or from the command line (user scope makes it available in every project):

```bash
claude plugin marketplace add NerdOutInc/recall-plugins
claude plugin install recall@recall --scope user
```

Start a new thread after installing so the plugin tools are loaded.

## Host and memory support

Plugin installation, a local MCP connection, skills, and lifecycle hooks are
separate capabilities. Static manifest wiring and host documentation are not a
substitute for a live Recall account test; the matrix marks routes that are not
yet live-certified instead of claiming them as verified. The current support
boundary is:

The journal column describes existing **v1–v5 and v7 assisted journaling**,
not a certified v6 recording pilot. Claude Code and Codex still require actual
host certification before v6 activation; Cursor has no v6 recording profile.

| Surface | Recall tools and skills | Assisted journal or project memory (v1–v5, v7) |
| --- | --- | --- |
| Codex app and Codex CLI | Supported through the local bridge after plugin trust and native approval. | Supported. The bundled Codex `SessionStart` and `UserPromptSubmit` hooks read this agent's config: the session event carries the protocol, each prompt a short reminder. |
| Claude Code | Supported through the local bridge after plugin installation and native approval. | Supported. The bundled Claude Code `SessionStart` and `UserPromptSubmit` hooks read this agent's config: the session event carries the protocol, each prompt a short reminder. |
| Cursor | Supported through its separate Cursor plugin and a Cursor-specific native approval. | Supported through Cursor's `sessionStart` hook, stable `session_id` (the conversation id), and `~/.cursor/recall-journal.json`. |
| Claude Desktop Chat | The shared plugin statically registers Recall's local stdio tools and skills. This route has not been re-certified live by Recall in the current Claude Desktop release. | Not automatic. Hooks do not run in ordinary Chat; invoke a skill or Recall tool explicitly. |
| Claude web Chat | Plugin skills can be available, but the web surface cannot directly launch this local stdio server or dial Recall's loopback listener. | Not automatic. Hooks do not run in ordinary Chat, and a skill alone cannot supply Recall tools. |
| Cowork local execution on Claude Desktop | Anthropic documents local plugin MCP servers on the device, but this Recall route is not yet live-certified. Recall and Claude Desktop must both remain running for tool use. | Not yet Recall-certified. Cowork runs plugin hooks, but the current Recall hook treats every non-Codex host as Claude Code and reads the Claude Code config location. |
| Cowork cloud session with Claude Desktop open and online | Anthropic documents a Desktop-brokered route to local connectors and plugin MCP servers. The stdio bridge and Recall listener stay on the Mac; the cloud sandbox never connects to `127.0.0.1` directly. Recall has not yet live-certified this route. | Not yet Recall-certified. Cowork can run plugin hooks, but Recall has not verified the hook payload, config location, or working-directory mapping for this route. |
| Cowork cloud session with Claude Desktop closed or offline | Recall tools are unavailable. Plugin instructions may still load in Cowork, but no desktop broker can reach the Mac-local server. | Tool-backed Recall memory is unavailable; never treat loaded instructions as a successful Recall connection. |
| ChatGPT chat and work surfaces | This package does not currently register a ChatGPT app or connection. | Unsupported. A Codex plugin install and Codex lifecycle hooks do not establish automatic memory in ChatGPT chat. |

These boundaries follow the host documentation: Claude plugin skills work in
Chat and Cowork, while hooks run in Cowork rather than ordinary Chat. A Cowork
cloud sandbox has no direct cloud loopback path to Recall, but Claude Desktop
can keep the plugin MCP process on the device and broker its tools into a cloud
session while the app is open and online. The loopback listener never becomes a
public connector.
([Claude plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude),
[Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile),
[Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)).
Adding `http://127.0.0.1:38473/mcp` as a cloud custom connector is therefore not
a workaround: remote connector traffic originates in Anthropic's cloud, while
this plugin deliberately registers a local stdio server
([remote MCP connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
OpenAI's plugin format can package capabilities for ChatGPT and Codex, but each
capability still needs a supported surface and configuration; this Recall
package currently ships a Codex MCP registration and Codex hook, not a ChatGPT
connection
([OpenAI plugins](https://learn.chatgpt.com/docs/plugins),
[Codex hooks](https://learn.chatgpt.com/docs/hooks)).

The journal config version controls automatic memory only where the host runs
the hook:

| Config | Repository session | Proven non-repository session | Writes |
| --- | --- | --- | --- |
| v1/v2 | A matching filesystem-project destination wins; otherwise the global destination remains available. | The global destination remains available, so existing general-purpose and non-Git chats keep working. | Legacy named-note journal and optional Today summary. |
| v3 | Repository-only structured lookup. No supported remote or no exact `resolve_project` match means no project memory. | No memory; v3 has no global or default fallback. | None; reader-only. |
| v4 | Repository-first structured lookup, even when the repository has no usable remote. Never use the default after `none`, `ambiguous`, or `not_ready`. | Read the one explicitly configured default Recall Project directly, but only after the hook proves no repository identity exists. | None; reader-only in this release. |
| v5 | Repository-first exact Project lookup and structured sessions. No supported remote or exact binding means no Project memory or journal for that repository; the default is never an error fallback. | Use the one explicitly configured exact default Recall Project only after the hook proves no repository identity exists. | App-owned sessions and human-scale checkpoints shown in Today -> Now activity, with an optional app-owned Today card at close. |
| v7 | A saved filesystem-project destination wins, even over a bound remote; otherwise repository-first exact Project lookup, falling back to the global destination when the remote is unbound, unsupported, or unresolved. | A saved filesystem-project destination wins; otherwise the global destination remains available, so non-Git chats keep structured memory. | App-owned sessions and human-scale checkpoints shown in Today -> Now activity, with an optional app-owned Today card at close. |

Do not auto-migrate v1/v2 users to a structured mode: doing so could silently
remove their global, non-Git memory. Version 0.28 can replace a legacy config
with v5 only after an explicit mode choice, a live whole-schema check, selection
of one exact write-ready default Project, and confirmation of the routing
change. Version 0.34 replaces a legacy config with v7 the same way, carrying
over Project-scoped global and filesystem-path destinations and requiring an
exact Project for any workspace-root destination. Version 0.38 has the hook
offer that upgrade once per session for every older config; the offer is
explicit, the skill's helper writes only a confirmed file, and a declined
offer leaves the file unchanged. Structured defaults under
v5 are not error fallbacks, and structured modes never mix with legacy
named-note writes. Direct, explicit Recall tool use remains
available wherever the local MCP connection and skills are actually loaded.

### Troubleshooting Claude surfaces

| Situation | Meaning | What to do |
| --- | --- | --- |
| Recall skills appear in Claude web Chat but Recall tools do not | Skills can load without a Mac-local MCP process. Web Chat has no direct loopback route. | Use Claude Desktop Chat, or a Cowork session with the same account and an open, online Claude Desktop broker. Do not register the loopback URL as a cloud connector. |
| Recall tools are missing in Claude Desktop Chat | The plugin has not loaded, Recall is not running, its MCP server is disabled, or native approval is pending. | Confirm the plugin is enabled, launch Recall, enable **Settings → MCP Server**, start a new Chat, bring Recall forward, and approve the native prompt. Hooks are unrelated to this check. |
| Recall tools are missing in cloud Cowork while Claude Desktop is open | The documented desktop-broker route is not connected, or the local Recall prerequisites are incomplete. This path is not yet live-certified by Recall. | Keep Claude Desktop online on the same account, confirm the plugin is enabled there, then check Recall's app, MCP setting, native approval, and workspace policy. Do not claim success from a loaded skill alone. |
| Recall tools disappear after Claude Desktop closes or goes offline | Expected for a cloud Cowork session using a local plugin MCP server. The server remains on the Mac. | Reopen Claude Desktop and Recall before retrying the tool call. Do not retry journal writes blindly after an interrupted call; read back first. |
| Automatic Recall memory is absent in ordinary Chat | Expected. Claude's plugin hooks do not run in ordinary Chat. | Invoke the Recall skill or tools explicitly when the local connection is available. |
| Cowork labels the hook as Claude Code or cannot find its journal config | The current hook has no verified Cowork host/config contract. | Use explicit Recall tools only. Do not rely on automatic memory or create a guessed config path until a Cowork-specific release is live-certified. |
| Recall tools or approval prompts appear twice | The shared Claude plugin and legacy standalone Recall desktop extension are both installed. | Keep the shared plugin, remove or disable the standalone extension, and start a new conversation. |
| An older Recall build shows the client as `Claude` | Its OAuth/session label is advisory. Current host-attested builds instead authorize and attribute the verified signed host. | Update Recall for independent host grants. On older builds, use the surface and session itself to distinguish Chat, Cowork, or Claude Code; never treat the label as authorization or host proof. |

### Moving an existing install to Recall

Recall uses new marketplace, plugin, MCP server, skill, and journal-config
identifiers, plus separate OAuth cache paths when the fallback is active.
Existing installations do not update across those identity changes
automatically. Add the Recall marketplace, install
**Recall**, start a new thread, and approve the native prompt in Recall. An
older Recall build opens browser OAuth instead. Journal users should invoke
`$recall:recall-journal` once to create
`recall-journal.json`, choose current-filesystem-project or global scope, and
select a workspace plus optional Recall Project.

After the new Recall plugin works and its connection is approved, retire the
legacy plugin so its hooks and MCP connection do not run alongside Recall:

```bash
claude plugin disable nerd-out-notes@nerd-out --scope user
codex plugin remove nerd-out-notes@nerd-out
```

Run only the command for the host you migrated. Recall's direct-download Mac
app performs this cleanup automatically, but only after it verifies the
replacement plugin. Sandboxed builds and manual installs use the steps above.

## Setup

1. Open Recall for Mac.
2. Open Settings → Integrations and install the agent, or complete the manual
   install above.
3. Open Settings → MCP Server and choose block/read/write access per workspace.
4. Start a new agent thread and approve the local bridge in Recall.

No separate login command is needed. A compatible Direct Recall build can
use the native local-bridge prompt on first connection. Bring Recall to the
front, approve it, then start a new conversation or thread. The approval can be
revoked or reset under **Settings → MCP Server → Local bridge access**. Older
Recall builds fall back to browser OAuth and keep Cursor, Claude, and Codex credentials
separate under `~/.mcp-auth/recall/`.

> **Server name:** the plugin registers its server as `recall`, but the
> installed name may be namespaced — Claude Code registers plugin servers as
> `plugin:recall:recall`. If you don't see the server, run
> `codex mcp list` or `claude mcp list` to see the exact name.

The plugin connects to `http://127.0.0.1:38473/mcp`. That server is loopback-only
and runs inside the signed-in Recall Mac app.

<details>
<summary>Legacy token setup (older app builds)</summary>

If your Recall build does not support OAuth sign-in yet, use the shared
access token instead. This plugin version no longer wires the token env var, so
add the server manually:

1. In Recall, open Settings -> MCP Server and reveal the access token.
2. Register the server directly with your agent.

For Codex:

```bash
export NERD_OUT_MCP_TOKEN="<token-from-recall>"
codex mcp add recall --url http://127.0.0.1:38473/mcp --bearer-token-env-var NERD_OUT_MCP_TOKEN
```

For Claude Code:

```bash
claude mcp add --transport http recall http://127.0.0.1:38473/mcp --header "Authorization: Bearer <token-from-recall>"
```

Updating Recall for Mac and completing the browser sign-in from
**Setup** above (it runs automatically the first time the plugin's bridge
connects) replaces this setup.

</details>

## Tools

Recall advertises `list_notes`, `read_note`, `keyword_search`,
`semantic_search`, `get_index_status`, `list_workspaces`, and `list_projects`.
Newer builds also advertise `list_note_activity` for one named note's accepted
activity and extend `read_note` / `update_note_content` with canonical Markdown
plus opaque revision tokens for conditional writes. The skills inspect the
live schemas before using those additions; if the complete revision pair is
not present, they keep the legacy HTML/readback workflow without mixing fields.
Named-note list/search tools accept an explicit workspace + Project filter, and
`create_note` can file a new named note in that exact Project.
`create_today_note` makes one short, retry-safe Today card in an explicit
workspace and optional Project, with real backlinks to detailed notes. Note
Markdown supports `<details><summary>` blocks, which render as native
collapsible toggles in the editor. The
`create_note`, `create_today_note`, and `update_note_content` write tools — plus
`rename_note` on newer app builds, for title-only renames of named notes —
appear
when at least one workspace is set to **Write** in Recall's MCP Server
settings. Reads and writes are filtered independently by each workspace's
**Block**, **Read**, or **Write** policy; an unconfigured workspace stays
blocked.

Newer Recall builds also advertise a Project-bound coordination surface once
at least one readable workspace contains a live Recall Project. Structured
Project reads are `resolve_project`, `get_project_context` (bounded encrypted
context whose `sessions`, `entries`, `handoffs`, and `asks` sections are each
served only under that response's own exact capability flag, plus fail-closed
`brief` and `status`), `list_sessions`/`read_session` for durable agent work
sessions, `list_timeline` for typed immutable journal entries,
`list_handoffs`, `list_asks`, and `read_comment_thread`. The matching write
tools — `open_session`/`close_session`, `append_entry`,
`create_handoff`/`claim_handoff`/`close_handoff`, `pick_up_ask`/`resolve_ask`,
`reply_comment` (which can declare directed asks), and
`bind_project_repository` — follow the same per-workspace **Write** policy as
the note write tools. On OAuth transports the coordination reads require
`journal:read` (`get_project_context` requires both `notes:read` and
`journal:read`) and the coordination writes require `journal:write`; the
native local bridge needs no scopes. Handoff and ask transitions are
compare-and-set: a lost race returns the current status, never a lock, and
`targetAgentKind` is advisory routing, never authorization. An older Recall
build simply omits these tools; the skills inspect the live catalog instead of
assuming them from any version number.

## Skills

This plugin can ship multiple skills; both agents discover every subdirectory
under `skills/` that contains a `SKILL.md`. It currently includes:

- `recall` for direct note, search, and MCP workflows.
- `doctor` for diagnosing a conversation where Recall tools or journaling are
  unavailable in Claude Code, Codex, or Cursor. The helper
  (`scripts/recall-doctor`) passively inspects the Recall.app process, local
  socket, host ancestry, and supported diagnostic log metadata. Shared
  or unverified host boundaries stay `unknown`. The optional current read-tool
  inventory verdict is caller-reported, not process attestation or recording
  status. Only an explicitly authorized `--probe` starts a new connection;
  success there cannot certify the conversation that requested diagnosis.
- `recall-journal` for a Project-aware journal: on first use it shows the
  current filesystem project's absolute path and asks whether to configure that
  project or a global default. It then asks for a confirmed, write-ready Recall
  workspace and, when that workspace has Projects, an optional Recall Project.
  It saves the choice in a per-agent config (`$CODEX_HOME/recall-journal.json` for Codex,
  `$CLAUDE_CONFIG_DIR/recall-journal.json` — default `~/.claude` — for
  Claude Code), and then journals live into one note per chat thread: a
  dateless topic-phrase title, a short always-visible intro, and one
  collapsible toggle entry per checkpoint whose summary line reads like plain
  English while agent detail and hidden bookkeeping (journal marker, thread
  id, timestamps) stay inside the collapsed details. The thread's agent
  curates its own note as the work evolves — refreshing the intro, merging
  entries, and retitling when the thread changes direction — and on days the
  thread wraps up meaningful work it adds at most one tiny ELI5 Today card
  with a `Full journal entry` backlink (or none when day summaries are
  disabled) — so an interrupted session leaves a partial, resumable record
  instead of nothing.
  A config that still selects the retired legacy DailyNote summary target gets
  a one-time prompt to switch to Today or none; the Recall server no longer
  creates DailyNotes, so the skill never writes them. Bundled `SessionStart`
  and `UserPromptSubmit` hooks notice the valid opt-in config: the session
  event adds the full journal context once (and again after a resume or
  compaction), and each later prompt adds a short reminder, so the skill no
  longer has to discover a file before it has been loaded. The context names
  the configured workspace — and the chat thread's stable id when the host
  provides one — and works in both directions: it tells the agent to search
  existing journal notes when a task may relate to prior work — so the
  journal is read back as memory, not just written — and to open, update, and
  wrap up the thread's note as the work happens. A filesystem project can have its own destination even without
  a global default: the skill saves its canonical root path under `projects` in
  the same config. Sessions
  working anywhere inside that path — subfolders and worktrees checked out
  under the repo included — then journal to and recall from the project's
  workspace and optional Recall Project instead of the global destination.

  The hook can also read the version 3, version 4, version 5, and version 7
  project-memory shapes. Versions 3 and 4 are intentionally reader-only.
  Version 3 is repository-only; versions 4 and 5 are repository-first and may
  use one exact default Recall Project only after proving that no repository
  identity exists. Versions 5 and 7 are the structured writer: they open one
  app-owned session, record a handful of durable checkpoints, and close with
  the outcome and optional app-owned day summary. Version 7 additionally
  restores global and per-path destinations, each naming a Recall Project: a
  saved filesystem-project destination wins, then the repository's exact
  remote binding, then the global destination, and the hook names the chosen
  destination at session start and in every prompt's reminder. The session and checkpoints appear in **Today
  -> Now activity**; the optional day summary lands as an app-owned Today
  timeline card.
  Explicit setup can write v2 Legacy journal note or capability-gated v7
  Structured Project activity; it never auto-migrates an existing config, and
  the modes bypass one another so one prompt cannot enter both protocols.
  When the hook reports an older version or a file it cannot read, the
  skill's `scripts/upgrade-journal-config` helper plans the exact version 7
  replacement (`plan`) and, after live revalidation and the user's
  confirmation, writes it atomically (`apply`); the hook only reports.

In Codex, invoke skills as `$recall:recall`,
`$recall:doctor`, and
`$recall:recall-journal`; in Claude Code, use
`/recall:recall`,
`/recall:doctor`, and
`/recall:recall-journal`.

The journal skill is summary-first and never stores credentials or full
conversation transcripts by default. Enable MCP writes in the app before using
it to create or update notes.

After installing or updating the plugin, start a new thread so the hook is
loaded. Codex requires a one-time review and trust decision for plugin hooks;
the first explicit `$recall:recall-journal` invocation checks Codex's active
hook inventory and asks you to use `/hooks` when the Recall handler is new,
modified, disabled, or missing. Hook trust remains your decision: the skill
can detect and explain the state but never changes Codex's trust configuration
or bypasses the review. Claude Code has no separate per-hook trust switch, so
this preflight is Codex-only. The hook itself only checks the current agent's
`recall-journal.json` shape and injects agent context, including the workspace
and optional Recall Project that apply to the session — the filesystem
project's destination when its saved path matches, the global destination
otherwise — so the agent can search the journal right away.
It does not read note bodies, validate workspace access, or write notes; the
journal skill and MCP server keep those responsibilities.

If the agent reports a connection error, confirm the Mac app is open and the
server is enabled. If it reports an authorization error, start a new
conversation, choose **Allow again** under Recall's **Settings → MCP Server →
Local bridge access**, and approve the native prompt. If the MCP log says
`transport: oauth-http`, the older OAuth fallback is active instead; deleting
the affected agent's directory under `~/.mcp-auth/recall/` forces a fresh
browser sign-in without clearing the other agent. If you don't see the server,
use `codex mcp list` or `claude mcp list` to confirm its exact name.
