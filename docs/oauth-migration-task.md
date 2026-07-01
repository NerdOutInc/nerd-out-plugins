# Task: migrate the `nerd-out-notes` Codex plugin to MCP OAuth

Self-contained brief for an agent working in **`NerdOutInc/nerd-out-plugins`**. You do
not need prior context — everything you need is below. Read it fully before editing.

---

## 0. TL;DR

The `nerd-out-notes` Codex plugin currently authenticates to the Nerd Out Notes Mac
app's local MCP server with a **shared bearer token** the user pastes into an env var.
We are moving that server to **MCP OAuth** (the user runs `codex mcp login` instead of
exporting a token). Your job is to update this plugin so it uses OAuth.

**The change itself is small** — primarily removing `bearer_token_env_var` from
`.mcp.json`, rewriting the README setup, and bumping the version. **The hard part is
gating and verification**, not the edit. Read §1 and §3 carefully.

> ⚠️ **DO NOT PUBLISH the OAuth version until the app-side OAuth server is live AND you
> have verified the flow end-to-end (§3 Phase 0).** Publishing early will break the
> plugin for everyone. Land the change on a branch / draft PR and hold.

---

## 1. Critical prerequisite (why you probably cannot finish today)

This plugin talks to a loopback MCP server hosted inside the **Nerd Out Notes for Mac**
app (`http://127.0.0.1:38473/mcp`). OAuth for that server is being built in the
**`NerdOutInc/nerd-out-app`** repo in phases:

- **Done / in review:** three *inert* foundational PRs — `#126` (OAuth DB tables + RLS),
  `#127` (bridge methods `mcp_current_user` / `mcp_dispatch_tool` + resolve-once dispatch),
  `#128` (native ES256 JWT verifier + dual-mode `validate()` + RFC 9728 protected-resource
  metadata). **These change no behavior** — the Mac server still uses the bearer token and
  does **not** advertise OAuth. `McpServer.currentOAuthConfig()` returns `nil`.
- **NOT built yet (this is your blocker):** the authorization-server routes + JWKS in the
  web app, wiring `currentOAuthConfig()` to a live config, and switching native tool calls
  to verify the JWT → `mcp_dispatch_tool`, shipped in a **new Mac app release**.

Until that "next phase" is live and installed on your test machine, `codex mcp login`
against this server has nothing to discover and **will fail**. Confirm with the app team
that OAuth is live before doing §3 Phase 0.

Good news for rollout: the Mac server accepts **both** bearer and OAuth (dual-mode
`validate()`), so existing bearer users are not broken when OAuth ships — see §5.

---

## 2. Current state of this repo

Layout (`plugins/nerd-out-notes/`):

- `.codex-plugin/plugin.json` — plugin manifest. `name: "nerd-out-notes"`,
  `version: "0.1.0"`, `mcpServers: "./.mcp.json"`, `skills: "./skills/"`.
- `.mcp.json` — the MCP server declaration (this is what you change):

  ```json
  {
    "mcpServers": {
      "nerd-out-notes": {
        "type": "http",
        "url": "http://127.0.0.1:38473/mcp",
        "bearer_token_env_var": "NERD_OUT_MCP_TOKEN"
      }
    }
  }
  ```

- `README.md` — install + bearer-token setup instructions (Reveal token → `export
  NERD_OUT_MCP_TOKEN=...`). You rewrite the setup section.
- `skills/nerd-out-notes/SKILL.md` — the skill; unlikely to need changes (check whether it
  mentions the token).

Install command (from the README):
`npx codex-marketplace add NerdOutInc/nerd-out-plugins/plugins/nerd-out-notes --plugin --project`

---

## 3. How Codex OAuth works (verified against docs, ~July 2026 — RE-VERIFY before editing)

Sources: `https://developers.openai.com/codex/mcp` and
`https://developers.openai.com/codex/plugins/build`. **Docs change — re-fetch and confirm
each fact below; do not trust this section blindly, and do not invent config keys.**

- OAuth is initiated by the user running **`codex mcp login <server-name>`** for servers
  that support it. It is **not** auto-triggered by an HTTP 401 / `WWW-Authenticate` — the
  user runs the command, and Codex then does the discovery + DCR + PKCE flow.
- HTTP MCP server config keys (in `config.toml` under `[mcp_servers.<name>]` and,
  by extension, in a plugin's `.mcp.json`): `url` (required), `type: "http"`,
  `bearer_token_env_var` (optional), `http_headers` / `env_http_headers`.
- OAuth-related keys are **top-level** config, not per-server: `mcp_oauth_callback_port`,
  `mcp_oauth_callback_url`.
- **There is NO documented `oauth_resource` field.** An earlier internal plan referenced
  `oauth_resource` / `--oauth-resource`; that appears to be wrong. The RFC 8707 resource is
  the server `url`, handled by discovery during `login`. **Do not add an `oauth_resource`
  field unless Phase 0 proves one is actually required.**
- If the server advertises `scopes_supported`, Codex uses those during login (the Mac
  server's protected-resource metadata advertises `notes:read` and `notes:write`).
- Plugin-scoped server policy lives under `[plugins.<plugin>.mcp_servers.<server>]` in the
  user's `config.toml`.

### Phase 0 — VERIFY FIRST (this is the make-or-break step)

The docs are **silent** on whether `codex mcp login` works for a *plugin-bundled* server
and what name it expects. Prove the whole flow locally before changing the published
plugin, with a Mac app build that has OAuth live (§1):

1. Make a scratch copy of the plugin with `bearer_token_env_var` removed from `.mcp.json`
   (leave only `type` + `url`). Install it into a throwaway Codex project.
2. Run `codex mcp login nerd-out-notes` (try the plain server name first). Confirm a browser
   opens, Supabase sign-in + consent completes, and Codex stores a token.
3. In a fresh Codex thread, confirm the tools work: list notes, read a note, keyword +
   semantic search, and — with "Allow writes" on in the Mac app — create/update a note.
4. Confirm token **refresh** and **revoke** behave (revoke in the app / AS, confirm Codex
   re-prompts).

**Resolve these unknowns and write the answers into this file / the PR before publishing:**

- **Server name for `login`:** is it `nerd-out-notes`, or a plugin-namespaced form
  (`<plugin>.<server>`)? Update the README with whatever actually works.
- **Callback port:** does Codex's default ephemeral loopback port work, or must the AS
  allow any loopback port (it was designed to, per RFC 8252 §7.3) — or must the user set a
  fixed `mcp_oauth_callback_port`? If a fixed port is needed, document it.
- **Does removing `bearer_token_env_var` alone switch Codex to OAuth**, or is an explicit
  opt-in required? Adjust `.mcp.json` accordingly (but avoid undocumented keys).

If Phase 0 reveals the plugin path can't cleanly do OAuth, STOP and report back — the
fallback is to keep the bearer plugin and document manual `config.toml` OAuth setup.

---

## 4. Phase 1 — the changes (after Phase 0 passes)

Keep the diff minimal. Expect ~3 files:

1. **`plugins/nerd-out-notes/.mcp.json`** — remove `bearer_token_env_var` so the entry is:

   ```json
   {
     "mcpServers": {
       "nerd-out-notes": {
         "type": "http",
         "url": "http://127.0.0.1:38473/mcp"
       }
     }
   }
   ```

   (Add an OAuth field ONLY if Phase 0 proved one is required — see §3.)

2. **`plugins/nerd-out-notes/README.md`** — replace the "Reveal token / `export
   NERD_OUT_MCP_TOKEN`" setup with the OAuth flow:
   - Open Nerd Out Notes for Mac → Settings → MCP Server → enable.
   - `codex mcp login nerd-out-notes` (use the verified name) → sign in + consent in the
     browser.
   - Start a new Codex thread; no token export needed.
   - Keep a **collapsed "Legacy token setup"** section for users on older app builds during
     rollout (the server still accepts the bearer token).
   - Update the troubleshooting note (it currently says to check `NERD_OUT_MCP_TOKEN`).

3. **`plugins/nerd-out-notes/.codex-plugin/plugin.json`** — bump `version` `0.1.0` → `0.2.0`.

4. Check `skills/nerd-out-notes/SKILL.md` for any mention of the token / setup and update if
   present.

---

## 5. Phase 2 — rollout (do not skip the ordering)

- A single `.mcp.json` entry can't offer both bearer and OAuth: if `bearer_token_env_var`
  is set, Codex uses the token and never tries OAuth. So the switch is per-plugin-version.
- The Mac server accepts both auth modes, so **existing users on the current (bearer)
  plugin keep working** after OAuth ships.
- Sequence: (1) land this change on a branch / draft PR and hold; (2) confirm the app-side
  AS integration is live in a released Mac build; (3) complete Phase 0 on that build;
  (4) merge + publish the OAuth plugin version and update the marketplace listing.
- Consider a short transition window where both a bearer and an OAuth path are documented.

---

## 6. Acceptance criteria

- [ ] Phase 0 verified end-to-end against a live OAuth Mac build; the three §3 unknowns are
      answered and recorded.
- [ ] `.mcp.json` no longer contains `bearer_token_env_var` (and contains no undocumented
      OAuth keys).
- [ ] README setup uses `codex mcp login <verified-name>`, with a collapsed legacy-token
      fallback and updated troubleshooting.
- [ ] `plugin.json` version bumped.
- [ ] A clean install (`codex-marketplace add ...`) + `codex mcp login` + tool calls
      succeed on a fresh machine.
- [ ] Change is on a branch / PR marked "hold — do not publish until app OAuth is live".

---

## 7. Conventions

- Author commits as **Brian Pattison `<brian@brianpattison.com>`**. Do **not** add
  `Co-Authored-By: Claude` or any AI/Claude/Anthropic attribution to commits or PR
  descriptions.
- Keep changes minimal and match the repo's existing JSON/Markdown style.
- Ask the human before publishing to the marketplace or merging to `main` — this is
  outward-facing and gated on the app release.

---

## 8. Open questions for the human

1. Is the `nerd-out-app` OAuth authorization-server phase live in a **released** Mac build
   yet? (If not, this task is blocked at Phase 0.)
2. Do we want a transition period where both bearer and OAuth are supported/documented, or
   a hard switch at publish time?
3. Should the OAuth plugin be a new version of the same marketplace entry, or published
   alongside the bearer one during rollout?

## 9. References

- App-side foundations: `NerdOutInc/nerd-out-app` PRs `#126` (DB), `#127` (bridge),
  `#128` (native ES256 verifier). All inert until the AS integration wires
  `currentOAuthConfig()`.
- Codex docs: `https://developers.openai.com/codex/mcp`,
  `https://developers.openai.com/codex/plugins/build`.
- MCP authorization spec (RFC 9728 protected-resource metadata, RFC 8707 resource, RFC 8252
  loopback redirect, PKCE): `https://modelcontextprotocol.io/specification`.
