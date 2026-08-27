---
name: doctor
description: Diagnose why Recall MCP tools or journaling are unavailable in an agent session. Use when the user invokes the doctor skill (/recall:doctor in Claude Code), when lifecycle context reports the Recall connector was not started, when the Recall MCP tools are missing from the session's tool list, or when Recall MCP calls fail. Read-only diagnosis of the whole connection chain that names the first broken link and its fix.
---

# Recall Doctor

Automates the diagnosis chain for "Recall tools don't work in this session":
the Recall Mac app, its loopback MCP listener, the app-group socket, this
session's own bridge process, a live probe of the bridge, and the newest
connection log. One run names the first broken link and the fix, instead of
the user hand-checking six layers.

## Running the diagnosis

Resolve the `scripts/` directory relative to this `SKILL.md`, then run the
absolute path to `scripts/recall-doctor` from the session's current working
directory (the working directory selects which connection log is inspected).
On Codex or Cursor pass `--client-name Codex` or `--client-name Cursor`; the
default is `Claude`.

The helper prints one JSON report and changes nothing on the machine. Its
only side effect is the bridge probe, which launches a short-lived bridge
process exactly the way the host does when it connects — if the user has
never approved this agent, Recall may show its normal consent prompt.

## Reading the report

The report has `checks` in dependency order, `firstBrokenLink`, and a
one-line `summary`:

- `recall-app` — the Recall.app process exists.
- `mcp-listener` — the loopback listener answers on 127.0.0.1:38473
  (release) or :38474 (debug).
- `app-group-socket` — the app-group socket the Recall-signed helper uses.
  Missing is a warning, not a failure: older apps fall back to OAuth through
  the loopback listener.
- `session-bridge` — whether THIS session's host process has a Recall bridge
  child. `absent` with everything else healthy is the signature of the host
  silently skipping the connector for one session; the fix is a new session.
  `unknown` usually means the doctor was not run from inside the agent
  session, so the session's host process is not an ancestor of the check.
- `bridge-probe` — a freshly launched bridge answered JSON-RPC `initialize`;
  the detail reports the server's name and version. Failures carry the exit
  code, its meaning under the signed helper's contract, and a stderr tail.
- `connection-logs` — informational: the newest
  `mcp-logs-plugin-recall-recall` log for this working directory. A missing
  directory means no connection was ever attempted here, which corroborates a
  `session-bridge: absent` finding.

## Presenting the result

Lead with the `summary`. When a link is broken, give the user that check's
`fix` in plain words and stop there — do not walk every healthy check. When
the chain is healthy but the session still has no Recall tools, say exactly
that: the machine side works, the host did not attach the connector to this
session, and a fresh session is the fix. Offer to read the newest connection
log only when the user wants the deeper detail.
