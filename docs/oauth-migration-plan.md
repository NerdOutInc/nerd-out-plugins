# MCP OAuth end-to-end plan

*Supersedes `docs/oauth-migration-task.md`. This document covers the full path from the current shared-bearer-token auth to MCP OAuth for the Recall loopback MCP server: the missing web-app authorization server (the real blocker), the native Mac-app cutover, the settings/UX changes, and the small `recall-plugins` Codex plugin change — sequenced so that existing bearer users never break.*

> **Naming update (2026-07-30).** Current product and plugin references use
> Recall, `recall-plugins`, and `recall-notes`. Historical source identifiers
> such as the still-canonical `nerd-out-app` repository, the former bearer
> environment variable, and dated issuer discussions remain literal evidence
> from the migration period.

> **Provenance & verification (2026-07-01).** The app-side claims below were derived from a deep read of `NerdOutInc/nerd-out-app` at `origin/main` (HEAD = `d8f800f7`, the "MCP OAuth (3/3)" merge — #126 + #127 + #128 all merged). The load-bearing facts were then independently re-verified in a clean `main` worktree: `currentOAuthConfig()` hard-returns `nil` (`McpServer.swift:124`; comment at `McpHttpProtocol.swift:239`); the dual-mode `validate(...oauth:)` / `authorize(...oauth:)` seam exists and is byte-identical to the legacy bearer path when `oauth == nil` (`McpHttpProtocol.swift:123,242`); the ES256 verifier is present and explicitly inert (`McpOAuthVerifier.swift`); the six `OAuth*` tables + default-deny RLS exist (both `2026063000000{0,1}` migrations); the web app has **no** `/oauth/*`, `/.well-known/oauth-*`, or JWKS routes (`proxy.ts` is the only middleware; only `.well-known/apple-app-site-association` exists); and per-tool write gating lives in `McpToolCatalog` / `McpHttpProtocol.swift:192` but scope is **not** enforced in the verifier. Codex config facts were re-verified against the July 2026 OpenAI docs (`/codex/mcp`, `/codex/plugins/build`, and the config reference) **and** against the installed `codex-cli 0.130.0` binary's config parser. Re-verified again on 2026-07-01 against the newer `origin/main` tip `38b6c2dc` after a Codex cross-review: the OAuth path is still inert and the anchors below still hold. **Line numbers are anchors, not literals** — re-locate symbols before editing (see §2.0).

---

## 1. Overview & goal

The `recall-notes` Codex plugin authenticates to a loopback-only MCP server hosted inside the **Recall for Mac** app at `http://127.0.0.1:38473/mcp`. Today that server accepts exactly one credential: a shared bearer token the user pastes into the `NERD_OUT_MCP_TOKEN` env var (32-byte CSPRNG secret, base64url-no-pad, stored in the Keychain — `McpKeychain.loadOrCreate()`/`generateToken()`, validated by a constant-time compare in `McpHttpProtocol.authorize` at lines 272–278).

**Goal:** move that server to **MCP OAuth 2.1**, so the user runs `codex mcp login` once (browser sign-in + consent) instead of exporting a long-lived shared secret, and so each token is bound to a specific Supabase user (`sub`) with scoped access (`notes:read` / `notes:write`).

**Key enabling fact from the audit:** the native app already ships a **dual-mode** authorization path. `McpHttpProtocol.authorize(_:token:oauth:now:)` (lines 242–279) branches on whether an `McpOAuthConfig` is present: with OAuth live it accepts *both* a verified ES256 JWT *and* the legacy bearer token (credential-only compare at 264–265, case-insensitive scheme), and a failed JWT never falls through to the bearer compare (256–262). So enabling OAuth does **not** break existing bearer users — the migration can be staged. The entire OAuth path is currently gated **off** by a single switch (see §2). **This dual-mode seam is asserted against the merged superset tree; §2.0 states which tree is canonical and Phase B step 0 re-confirms it before any wiring.**

The work spans two repos:
- **`NerdOutInc/nerd-out-app`** — the real blocker. The authorization server (AS) does not exist yet, and the native OAuth path is inert. This is the bulk of the effort (§3, §4, §5).
- **`NerdOutInc/recall-plugins`** (this repo) — a ~4-file diff, gated on the app work (§6).

---

## 2. Current state — what actually landed vs. what is inert

### 2.0 Canonical tree: the merge of all three PRs — RESOLVE THIS FIRST

The three foundational PRs were audited **on separate worktrees**, and two of those audits describe **mutually incompatible trees**: the PR #127 worktree (and its default checkout) had **no `currentOAuthConfig` symbol anywhere in `apple-app/Sources`** and a **bearer-only `validate()` with no `oauth` parameter** (`McpHttpProtocol.swift:105`), whereas the PR #128 audit describes `validate(...oauth:...)` at line 123 and a dual-mode `authorize()`. **These are two different snapshots of `origin/main` at different points in the merge sequence — the #127-audited tree is *pre-#128* and does not contain the dual-mode seam.**

**Canonical state for this entire plan: the post-merge superset — `origin/main` with #126 AND #127 AND #128 all merged (#128 last).** All of §4's "already built, just wire it" claims (dual-mode `authorize()`, `currentOAuthConfig()` returning `nil`, the `oauth:` parameter on `validate()`, the ES256 verifier, RFC 9728 PRM builders) refer to *this* superset tree, which is #128's reality, not #127's pre-#128 snapshot.

**Mandatory gate before any Phase B work (see §4 step 0):** check out the actual current `origin/main` HEAD and confirm, by grep/inspection, that all of the following coexist in one tree:
1. `McpServer.currentOAuthConfig()` exists and returns `nil` (`McpServer.swift:124-126`).
2. `McpHttpProtocol.authorize(_:token:oauth:now:)` has the `oauth:` parameter and the dual-mode branch (~lines 242–279).
3. `validate(...)` accepts an `oauth` argument and whitelists the PRM well-known routes when `oauth != nil` (~line 123, `McpHttpProtocol.swift:149-151`).
4. `McpOAuthVerifier.verify(_:config:now:)` and `McpOAuthConfig` exist (`McpOAuthVerifier.swift:112`, `:50`).
5. The RFC 9728 PRM builders exist (`McpOAuthMetadata.protectedResource`, `McpOAuthVerifier.swift:305`).

If any of these is absent from the actual HEAD (e.g. a merge dropped a hunk, or #128 was reverted), **STOP and reconcile** — do not proceed to §4 steps 3–5, which assume the superset. Line numbers below are from the #128 audit and will drift after merge; treat them as anchors to re-locate, not literals.

The three PRs are additive and change **no runtime behavior** today (the master OFF switch, §2.4, keeps every OAuth code path dormant).

### 2.1 PR #126 — OAuth 2.1 data model + RLS (DB foundation, BUILT, inert)
Two additive migrations (`web-app/supabase/migrations/20260630000000_add_mcp_oauth_tables.sql`, `..._add_mcp_oauth_rls.sql`) create six server-only tables:

| Table | Role | Key columns |
|---|---|---|
| `OAuthClient` | DCR/RFC 7591 client registry | `clientId` UNIQUE (FK target), `redirectUris[]`, `grantTypes[]`, `scope`, `tokenEndpointAuthMethod` DEFAULT `'none'` (public/PKCE only — **no secret column**) |
| `OAuthAuthorizationCode` | Single-use PKCE-bound codes | `codeHash` UNIQUE (hashed), `codeChallenge` NOT NULL, `codeChallengeMethod` DEFAULT `'S256'`, `resource` NOT NULL (RFC 8707), `scope`, `expiresAt`, `consumedAt`, `clientId`, `redirectUri`, `userId` |
| `OAuthGrant` | Durable consent (client+user+scope+resource) | `revokedAt`; parent of refresh tokens |
| `OAuthRefreshToken` | Rotating refresh tokens | `tokenHash` UNIQUE (hashed), `consumedAt`, self-ref `replacedById` UNIQUE (rotation/reuse-detection chain), FK `ON DELETE SET NULL` |
| `OAuthSigningKey` | JWKS source | `kid` UNIQUE, `publicJwk` JSONB, `status`, `retiredAt` — **public key only** |
| `OAuthRateLimit` | Fixed-window counters | `bucket` UNIQUE, `count`, `windowStart`, `expiresAt` |

RLS posture (`..._add_mcp_oauth_rls.sql` L39–51): **RLS ENABLED with zero policies (default-deny) + `REVOKE ALL FROM anon, authenticated`** on all six tables. All access is via Prisma on the `service_role`/`postgres` connection (which bypasses RLS); tables are excluded from `supabase_realtime`. Secrets are hashed, never plaintext. **Access tokens are not stored** — the design implies self-contained ES256 JWTs verified against `OAuthSigningKey` public keys. **Inert:** no application code reads or writes any of these tables yet (file header: "Nothing reads/enforces them yet").

### 2.2 PR #127 — bridge web-methods + resolve-once dispatch (BUILT, inert)
**Correction to prior brief:** these are **TypeScript web-methods**, not Swift bridge methods. PR #127 changes **zero `apple-app/` files** (`git diff --stat main...HEAD -- apple-app/` is empty). This is why the #127-audited worktree lacked the #128 native symbols — #127 never touched native code, and its snapshot predated the #128 merge (§2.0).
- `mcpCurrentUser` (`web-app/lib/mcp/mcp-current-user.ts:12`) — `() => Promise<{id}|null>`, resolves the signed-in user from the **authoritative Supabase session** (`supabase.auth.getUser()`), fails closed to `null`.
- `mcpDispatchTool` (`web-app/lib/mcp/mcp-dispatch-tool.ts:43`) — "resolve-once" dispatcher: calls `getUser()` **once**, throws if no user or if `payload.user.id !== currentUserId`, then dispatches via a **`Map`** registry (`TOOL_HANDLERS`, lines 26–35 — a Map not an object, so `toolName` can't resolve `__proto__`/`toString`) with `{userId}` injected as context. **The registry is keyed by the `WebMethods` key** (`mcp_create_note`, `mcp_read_note`, `mcp_update_note`, …), **not** the public MCP tool name (`create_note`, `read_note`, `update_note_content`) — the registry comment states this is "what the native side passes as `toolName`". The native cutover (§4) must pass `tool.webMethod`, not `params["name"]`.
- Both registered via `exposeToNative()` in `register-mcp-web-methods.ts:34-35`. **Inert:** no Swift code ever calls them (`grep` of `apple-app/Sources` returns nothing). Today the native `McpServer.handleToolCall` still forwards each `tools/call` **directly** to the per-tool web-method (`shell.mcpInvokeWebMethod(tool.webMethod, …)` → `mcp_list_notes` etc.), bypassing dispatch entirely.

### 2.3 PR #128 — native ES256 verifier + dual-mode `validate()` + RFC 9728 PRM (BUILT, inert)
All in `apple-app/Sources/`:
- `McpOAuthVerifier.verify(_:config:now:)` (`McpOAuthVerifier.swift:112`) — pure CryptoKit ES256 verifier: structural parse → **alg pinned to ES256 before key lookup** (alg-confusion defense, 166–168) → `kid` lookup in an **in-memory** JWKS (`McpJwks`, 39–45) → 64-byte raw r‖s P-256 signature (181–188) → `iss` exact, `aud`/`resource` RFC 8707 exact-match (string or array, 233–244), `exp` required + `clockSkew` (default 60s), `nbf` optional, `sub` non-empty → enforces token carries **all** `config.requiredScopes` (single flat set, 211–213). **`kid` miss fails immediately with no refetch (169–171).** `iat` is **not** validated. Fails closed. 362-line test suite (`McpOAuthVerifierTests.swift`).
- `McpOAuthConfig` (`McpOAuthVerifier.swift:50`) — carries `issuer`, `resource`, `requiredScopes`, `jwks`, `clockSkew`.
- `McpHttpProtocol.authorize` (242–279) — dual-mode, as described in §1.
- RFC 9728 protected-resource metadata builders (`McpOAuthMetadata.protectedResource`, `McpOAuthVerifier.swift:305`): advertises `resource=endpointURL`, `authorization_servers=[oauth.issuer]`, `scopes_supported=[notes:read, notes:write]`, `bearer_methods_supported=[header]`. Routes `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. `WWW-Authenticate` challenge builder (`wwwAuthenticate`, line 325).

### 2.4 The single OFF switch
**`McpServer.currentOAuthConfig()` hard-returns `nil`** (`McpServer.swift:124-126`). Consequences, all confirmed by the audit:
- `authorize()` takes the **legacy branch**; no JWT is ever verified in production.
- The two `/.well-known/oauth-protected-resource[/mcp]` routes are **403'd** — `validate()` only whitelists them when `oauth != nil` (`McpHttpProtocol.swift:149-151`); otherwise they fail `isAllowedPathMethod` (only `/mcp` POST + `/status` GET are allowed, 159–161). **OAuth is not advertised today.**
- A 401 carries body `{"error":"invalidAuthorization"}` with **no** `WWW-Authenticate` header (that header is added only when `oauth != nil`, `McpServer.swift:305-306`).

**Correction to prior brief:** the brief calls #126/#127/#128 "Done / in review." They are **merged to `origin/main`**. The "inert" characterization is correct; "in review" is stale. Note the merge-sequence caveat in §2.0: the canonical tree is the superset with all three merged.

---

## 3. The blocker in detail — the missing authorization server (web-app)

The audit confirms **nothing** OAuth-AS-shaped exists in `nerd-out-app/web-app`: no `/.well-known/oauth-authorization-server`, no `/.well-known/oauth-protected-resource`, no `/oauth/*` routes, no JWKS endpoint, and **no ES256/JWT signing infrastructure at all** — `package.json` has no `jose`/`jsonwebtoken`; `env.mjs` defines only the three Supabase vars + `ANALYZE`; `lib/crypto` is client-only note E2EE (RSA-OAEP/AES-GCM), not reusable for token signing. Every AS component is greenfield.

### Environment & platform grounding (from audit)
- **Next.js 16.2.9, App Router, Cache Components enabled.** Route-segment config (`export const dynamic/runtime/revalidate`) is **disallowed**; cache via `Cache-Control` headers (pattern: `app/.well-known/apple-app-site-association/route.ts`).
- Route-handler templates: `app/api/health/route.ts` (minimal JSON), `app/auth/confirm/route.ts` (`NextRequest` + `new URL(request.url)` + `NextResponse.redirect`).
- Supabase: `createAdminClient()` (`lib/supabase/admin.ts`, service-role, bypasses RLS) for AS table access; `createClient()` (`lib/supabase/server.ts`, cookie-bound) + `getCachedUser()` (`lib/supabase/get-cached-user.ts:15`) to resolve the consenting user in `/authorize`.
- **Middleware is `proxy.ts` (not `middleware.ts`)** — Next 16 rename. Its matcher currently excludes only `/.well-known`; **`/oauth/*` currently flows through `updateSession()`**. The matcher must be adjusted (§3.9).

### New web-app artifacts to build

Add a signing/JWT dependency (`jose` recommended — Web-Crypto-native, works in the Next runtime). Add env vars to `env.mjs` (§3.7). Base URL/issuer origin must be a **fixed configured constant**, never request-derived (§3.7, §5-issue below, §10 Q1).

#### 3.1 AS discovery metadata — `GET /.well-known/oauth-authorization-server` (RFC 8414)
Static-ish JSON, cached via `Cache-Control`. Must advertise:
- `issuer` — the **fixed `OAUTH_ISSUER` constant** (see §3.7); must byte-match the `iss` the native verifier pins **and** the `iss` the token endpoint mints. Never derived from request origin.
- `authorization_endpoint` = `<issuer>/oauth/authorize`,
- `token_endpoint` = `<issuer>/oauth/token`,
- `registration_endpoint` = `<issuer>/oauth/register`,
- `jwks_uri` = `<issuer>/oauth/jwks` (or `/.well-known/jwks.json`),
- `scopes_supported` = `["notes:read","notes:write"]` (must match native `scopes_supported`),
- `response_types_supported` = `["code"]`,
- `grant_types_supported` = `["authorization_code","refresh_token"]`,
- `code_challenge_methods_supported` = `["S256"]` (PKCE mandatory; `plain` deliberately absent so clients that refuse `plain`-offering servers still proceed).
- `token_endpoint_auth_methods_supported` = `["none"]` (public clients — matches `OAuthClient.tokenEndpointAuthMethod` DEFAULT `'none'`).
- **Intentional omissions (document them so they read as deliberate, not missing):** no `revocation_endpoint` and no `introspection_endpoint` — access tokens are self-contained short-TTL JWTs with no denylist (§3.7, §5), and refresh revocation is via `OAuthGrant.revokedAt`. State this in a code comment so Codex/reviewers don't probe for them.
- DB: read-only.

#### 3.2 Protected-resource metadata wiring (RFC 9728) — decision required + discovery-chain confirmation
The RFC 9728 PRM is **already served by the native Mac server** (PR #128, `McpOAuthMetadata.protectedResource`) at the loopback origin — once OAuth is live. **Decision (§10 Q2):** keep PRM native (no web-app route needed) vs. also expose it web-side. **Recommendation: keep it native** — it already exists, and its `resource` must equal the loopback MCP URI, which is the native server's own origin. No new web-app route for PRM; just ensure its `authorization_servers[0]` equals the AS `issuer` from 3.1.

**Discovery-chain caveat (must be confirmed in Phase 0, §7):** keeping PRM native-only is only safe if Codex probes the **resource** (the loopback server) for PRM first, then follows `authorization_servers[0]` to the AS's `/.well-known/oauth-authorization-server`. The expected chain is: resource URL `http://127.0.0.1:38473/mcp` → native PRM (`authorization_servers[0]` = AS issuer) → web AS metadata → register/authorize/token. **If Codex instead expects PRM served at the AS origin, native-only PRM breaks discovery** and we must also expose a web-side PRM. Do not commit to native-only until Phase 0 confirms which well-known URL Codex fetches first and from which origin (§7 Unknown 4).

#### 3.3 Dynamic Client Registration — `POST /oauth/register` (RFC 7591)
- Accepts `redirect_uris`, `grant_types`, `token_endpoint_auth_method`, optional `client_name`, `scope`. Codex does DCR during `codex mcp login`.
- Writes an `OAuthClient` row (public client, `tokenEndpointAuthMethod='none'`, no secret). Returns `client_id` (+ registered metadata).
- **RFC 8252 loopback redirect registration & validation (tightened — see #3.4 for the enforcement point).** Codex uses an ephemeral loopback redirect. At registration, **normalize and store the redirect URIs**, and reject anything that is not a literal loopback form. A registered `redirect_uri` is valid iff:
  - scheme is exactly `http`,
  - host is one of the **literal loopback forms**: `127.0.0.1`, `[::1]`, or `localhost` (RFC 8252 §7.3 — literal loopback IP / the reserved name only; **arbitrary hostnames are rejected**),
  - the path is captured and stored verbatim.
  Store host + path (and the fact that it is loopback). **The port is the only component allowed to vary** at `/authorize` time; everything else must match exactly. Do **not** implement "match host, ignore port" with loose host matching — that is an open-redirect footgun; match the host against the literal loopback allowlist.
- DB: writes `OAuthClient`. **Rate-limit via `OAuthRateLimit`** (per IP).

#### 3.4 Authorization endpoint + consent — `GET /oauth/authorize`
- **`redirect_uri` is required and never defaulted.** Validate it against the client's registered `redirectUris` with the RFC 8252 loopback rule from 3.3: (a) scheme `http`; (b) host ∈ {`127.0.0.1`, `[::1]`, `localhost`} and present in `OAuthClient.redirectUris`; (c) path matches the registered path **exactly**; (d) only the port may differ from the registered value; (e) reject on any other difference (open-redirect defense). Echo the exact `redirect_uri` into the code record and require the same exact value again at `/token` (RFC 8252 binding).
- Validate `client_id` (exists in `OAuthClient`), `response_type=code`, `code_challenge` + `code_challenge_method=S256` (**reject** if missing/non-S256 — PKCE mandatory), `scope` ⊆ supported, `resource` (RFC 8707; must equal the canonical loopback MCP URI — see §3.5 and §10 Q3, now a hard requirement).
- Resolve the signed-in user via cookie session (`getCachedUser()`); if not signed in, redirect to the existing Supabase sign-in flow (`app/auth/*`) and return.
- Render a **consent screen** (Server Component page, matching `app/auth/*/page.tsx` conventions) showing client name + requested scopes (`notes:read`/`notes:write`). On approval:
  - upsert an `OAuthGrant` (client+user+scope+resource),
  - mint a single-use authorization code, store its **hash** in `OAuthAuthorizationCode` (with `clientId`, `codeChallenge`, `codeChallengeMethod`, `resource`, `scope`, `expiresAt` short e.g. 60s, `redirectUri` echoed exactly, `userId`),
  - redirect to `redirect_uri` with `code` + `state`.
- **Rate-limit via `OAuthRateLimit`** (per IP and per `client_id`).
- DB: reads `OAuthClient`; writes `OAuthGrant`, `OAuthAuthorizationCode`.

#### 3.5 Token endpoint — `POST /oauth/token`
Handles two grant types. **Fail closed on any missing or mismatched field.**

- **`authorization_code`:** look up code by hash and enforce **all** of the following before minting; reject if any fails:
  - code exists, not expired, `consumedAt` is null;
  - `client_id` presented at `/token` **equals the code's issuing `clientId`** (code-injection defense);
  - `redirect_uri` presented **equals the code's stored `redirectUri`** byte-for-byte (RFC 8252 binding);
  - `resource` presented **equals the code's stored `resource`**;
  - `code_verifier` is **present and required** — a public client that omits it is rejected (never treated as optional) — and `BASE64URL(SHA256(code_verifier)) == codeChallenge` (S256);
  - then mark `consumedAt` (single-use, atomic — a compare-and-set so a concurrent replay loses).
  On success mint:
  - **access token** = self-contained **ES256 JWT**: `iss` = the fixed `OAUTH_ISSUER` constant, **`aud` = the canonical loopback MCP URI `http://127.0.0.1:38473/mcp` byte-for-byte** (see the hard requirement below), `sub` = **the Supabase `auth.users.id` verbatim** (see §4.3 requirement), `scope` = granted scope, short TTL (§3.7), `kid` of the active signing key. **Not persisted.**
  - **refresh token** = opaque; store **hash** in `OAuthRefreshToken` under the `OAuthGrant`.
- **`refresh_token`:** look up by hash; also verify `client_id` matches the grant's client and `resource` matches; if `consumedAt` already set → **reuse detected** → revoke the grant chain; else mint new access JWT + rotate refresh token (`consumedAt` + `replacedById` chain per PR #126 schema). Scope of the new access token is narrowed to the grant.
- **Rate-limit via `OAuthRateLimit`** — separate buckets **per `client_id` and per IP** (this is the brute-force / code-guessing surface).
- DB: reads/writes `OAuthAuthorizationCode`, `OAuthRefreshToken`, `OAuthGrant`, reads active `OAuthSigningKey`.

**HARD REQUIREMENT — audience exactness (promoted from open question).** The native verifier does an **exact** `aud` match against `config.resource`, and the native PRM builder sets `resource = endpointURL = http://127.0.0.1:38473/mcp`. Therefore the AS **MUST** mint `aud` equal to that exact loopback string — **not** the AS's own PWA/Vercel origin (the natural default), which would cause **every** token to be rejected. The AS must accept and echo that loopback URI as the RFC 8707 `resource` value even though it is not the AS's own origin. The port `38473` must be hard-coded identically on both sides (AS `aud` and native `config.resource`). This is launch-blocking and is no longer an open question; §10 Q3 is downgraded to "confirm the constant and its single source of truth."

#### 3.6 JWKS endpoint — `GET /oauth/jwks`
- Returns `{ keys: [...] }` from all `active` (and recently `retired`, for rotation overlap) `OAuthSigningKey.publicJwk` rows. Cached via `Cache-Control` (short, to allow rotation). **Public keys only.**
- **Must be served over HTTPS** (see §4.1 — the native fetch of this endpoint is the trust root; a plain-`http://` copy-paste here would be exploitable).
- This is what the **native side fetches out-of-band** to populate `McpJwks` (see §4). DB: reads `OAuthSigningKey`.

#### 3.7 ES256 signing-key generation, storage, and **publish-before-sign** rotation
- **Fixed issuer.** `OAUTH_ISSUER` is a **required env var / constant**, never derived from request origin. Deriving `iss` from the incoming request is unsafe: a request reaching the AS via a preview/Vercel alias domain would mint a token whose `iss` won't match the native `config.issuer`, silently breaking auth for the affected users, and origin-derivation is itself a spoofing surface. The metadata `issuer` (§3.1), the JWT `iss` (§3.5), and the native `config.issuer` (§4.1) MUST all reference this one constant. (§10 Q1 downgraded to "confirm dev vs prod values of the constant.")
- **Private key storage is undecided in code** (`OAuthSigningKey` holds only `publicJwk`). **Decision (§10 Q4).** Recommended: generate a P-256 keypair, store the **private** JWK in an env/secret (`OAUTH_SIGNING_PRIVATE_JWK` in `env.mjs`) and the **public** JWK + `kid` in `OAuthSigningKey`. Alternatively persist an encrypted private key in DB. Do **not** put the private key in `OAuthSigningKey` as-is (that table is public-JWK-by-design).
- **Access-token TTL is a hard, short constant.** Because there is no access-token denylist (§5 revoke has latency = TTL), set access-token TTL to **≤ 5 minutes**, and set it comfortably **greater than the native `clockSkew` (60s)** so the skew window is a small fraction of the lifetime rather than a large one (issue #14). Refresh-token TTL is the longer-lived credential and is revocable via the grant.
- **Rotation — publish-before-sign (concrete, because the native verifier does no `kid`-miss refetch, `McpOAuthVerifier.swift:169-171`).** The native side caches JWKS with a fixed TTL (`T_native`, defined in §4.1) and only refreshes on that schedule, so a `kid` that is signed-with before it is cached natively strands the first cohort of tokens. Rotation procedure:
  1. **Publish** the new key into `OAuthSigningKey` as `active` (so `/oauth/jwks` serves it) **without signing anything with it yet.**
  2. **Wait ≥ `T_native` + margin** (the maximum time until every native cache has refreshed and picked up the new `kid`).
  3. **Only then** switch the token endpoint to sign with the new `kid`.
  4. **Keep the old key published** in JWKS until `now > lastIssuedWithOldKid + accessTokenTTL + clockSkew` (no live token can still bear the old `kid`), then mark it `retired`/remove it.
  This guarantees any `kid` a token can carry is already in every native cache before it is used, and any `kid` still in flight remains resolvable. Encode the two timing constraints (`overlap_in ≥ T_native + margin`, `overlap_out ≥ accessTokenTTL + clockSkew`) next to the rotation code. (§10 Q7 downgraded to "confirm `T_native` and margin values.")
- New env vars in `env.mjs`: `OAUTH_ISSUER`, `OAUTH_SIGNING_PRIVATE_JWK`, `OAUTH_SIGNING_KID`, access-token TTL, refresh-token TTL (all constants, not request-derived).

#### 3.8 Expiry / garbage-collection sweeper
PR #126 adds `expiresAt` indexes but **no cron/trigger**. A sweeper (Supabase cron or a scheduled route) must GC:
- `OAuthAuthorizationCode` — **expired *and* consumed** codes (not just expired; single-use codes become garbage the moment they're consumed);
- `OAuthRefreshToken` — expired, **consumed**, and **revoked** rows, including long rotation chains (the `replacedById` self-FK is `ON DELETE SET NULL`, so deleting a chain is safe and won't orphan-block);
- `OAuthGrant` — old **revoked** grants once all their refresh tokens are gone;
- `OAuthRateLimit` — expired fixed-window rows.
- DB: deletes.

#### 3.9 Middleware matcher (`proxy.ts`)
The unauthenticated AS endpoints (`/oauth/token`, `/oauth/register`, `/oauth/jwks`, and the two `.well-known` docs) must **not** run `updateSession()`; `/oauth/authorize` legitimately needs the cookie session. Today only `/.well-known` is excluded, so `/oauth/*` currently passes through session refresh. Adjust the matcher accordingly.

### RFC compliance checklist
- **OAuth 2.1** — authorization-code + PKCE only, no implicit; public clients.
- **PKCE S256** — mandatory at `/authorize`, **`code_verifier` required and verified** at `/token`; missing verifier rejected (3.4, 3.5).
- **RFC 7591 DCR** — `/oauth/register`, loopback allowlist enforced (3.3).
- **RFC 8707 Resource Indicators** — `resource` captured on code + grant, minted as `aud` = exact loopback URI; native verifier requires exact match (3.4/3.5, **hard requirement in 3.5**).
- **RFC 9728 PRM** — served native (3.2); `authorization_servers` must equal AS `issuer`; discovery chain confirmed in Phase 0.
- **RFC 8414 AS metadata** — `/.well-known/oauth-authorization-server` (3.1); intentional omission of revocation/introspection documented.
- **RFC 8252 loopback redirect** — literal loopback host allowlist, exact path, **only the port varies**; `redirect_uri` required, echoed, and bound code→token (3.3, 3.4, 3.5).
- **Code-injection defenses** — `client_id`, `redirect_uri`, `resource` equality checks at `/token`; single-use atomic consume (3.5).
- **Transport** — HTTPS required for `/oauth/jwks` and all AS endpoints (3.6, §4.1).

---

## 4. Native app cutover (ships in a new Mac release)

Currently inert; this release turns it on. Grounded in the PR #128/#127 audit and the canonical superset tree (§2.0).

0. **Confirm the merged seam exists (gate — see §2.0).** Before touching anything, check out the real `origin/main` HEAD and verify items 1–5 in §2.0 coexist. Steps 3–5 below assume the dual-mode `authorize()`, `currentOAuthConfig()`, the `validate(oauth:)` seam, the ES256 verifier, and the PRM builders are all present in one tree. If they are not, STOP and reconcile the merge before proceeding. Re-locate the line numbers below (they will drift post-merge).

1. **Build the native out-of-band JWKS fetcher + cache (does not exist yet).** Populate `McpJwks` from a native fetch of `<OAUTH_ISSUER>/oauth/jwks`. Requirements:
   - **HTTPS only.** The JWKS/discovery fetch is the trust root for all token verification; the loopback MCP server is itself `http://`, so guard explicitly against a `http://` JWKS URL (reject non-HTTPS). `iss` and `jwks_uri` come from **trusted native config**, not from an attacker-influenceable discovery document.
   - **Cache with a defined TTL `T_native`** (the value the AS rotation in §3.7 depends on). Refresh periodically on that TTL. Because the verifier does no on-`kid`-miss refetch, `T_native` is the contract the AS's publish-before-sign window is built around; pick it deliberately and record it in both repos.
   - **Failure mode: do not brick the server.** If the JWKS fetch fails: retain the last-good cache. If there is **no** last-good cache (e.g. first launch offline), OAuth stays **off** for that session (fall back to bearer-only / behave as `oauth == nil`) rather than hard-failing the MCP server. Never let a JWKS outage take down bearer users.
2. **Wire `currentOAuthConfig()` to return a live `McpOAuthConfig`** (`McpServer.swift:124`). Populate:
   - `issuer` = the fixed `OAUTH_ISSUER` constant (dev/prod fork; must byte-match `iss` minted at §3.5),
   - `resource` = the canonical loopback MCP URI `http://127.0.0.1:38473/mcp` — must byte-match the `aud` minted by the AS (RFC 8707 exact; the hard requirement in §3.5). Single source of truth for the `38473` port shared with the PRM builder.
   - `requiredScopes` — see step 4 (per-request),
   - `jwks` = the `McpJwks` populated by step 1,
   - `clockSkew` = 60s (default) — note interplay with the ≥5min? / short access-token TTL (§3.7).
3. **Turning this on automatically activates** (all already built in the superset tree): JWT verification in `authorize()`, the two `/.well-known/oauth-protected-resource[/mcp]` routes, and the `WWW-Authenticate` challenge on 401 — because those code paths are gated on `oauth != nil`.
4. **Switch tool dispatch to verified identity — this is an explicit auth restructure, not just wiring (the rewire does not exist yet; PR #127 built only the web landing zone).** Today the ordering makes per-tool decisions impossible: `route()` runs `McpHttpProtocol.validate(...)` **before** the JSON-RPC body is parsed (`McpServer.swift:291`), `authorize()` returns only `McpSecurityError?` and **discards** the verified `McpAccessToken` on `.success` (`McpHttpProtocol.swift:256-262` — the `Result`'s payload, `McpAccessToken` at `McpOAuthVerifier.swift:83`, carries `subject` and `scopes`), and the tool name is only resolved later in `handleToolCall` (`McpServer.swift:410`). The cutover must:
   - (a) **Thread the verified token past `validate()`** — change `authorize()`/`validate()` to return (or stash in a request context) the `McpAccessToken` instead of dropping it. Transport-level checks (loopback, Host/Origin, size, path) stay early and unchanged.
   - (b) **Make the scope decision where the tool is known.** Either re-shape the flow so JWT verification runs after `tools/call` parsing with per-tool `requiredScopes`, or verify once early with the baseline scope and enforce `notes:write` membership at `handleToolCall` from the returned `McpAccessToken.scopes`. Both are acceptable; what is non-negotiable is that the scope-vs-tool check happens where `tool.requiresWrites` is resolvable (see step 5).
   - (c) **Call `mcp_dispatch_tool` (PR #127) with `{toolName: tool.webMethod, arguments, user:{id: token.subject}}`** instead of the raw per-tool `mcpInvokeWebMethod(tool.webMethod)`. Note `toolName` is the **`WebMethods` key** (`mcp_read_note`, `mcp_update_note`, …), not the public MCP tool name — the dispatcher's `TOOL_HANDLERS` map is keyed by web-method (§2.2). `mcpInvokeWebMethod` currently forwards raw args and must be changed to wrap them in the `{toolName, arguments, user}` shape.
   - **Identity-binding failure mode (define it, don't just rely on it).** `mcp_dispatch_tool` re-derives the webview user via `getUser()` and throws unless `payload.user.id === currentUserId`. The security property is: the token `sub` must equal the uid of whoever is signed into the webview. When they diverge (user signed out, or a different user is signed in), dispatch throws — **the native side must map that throw to `invalidAuthorization` (HTTP 401) so the `WWW-Authenticate` challenge fires and the client re-logs-in**, rather than surfacing a silent generic tool error. Decide and document this mapping explicitly.
   - **`sub` format is an AS requirement (§3.5).** The JWT `sub` must be **exactly** the Supabase `auth.getUser().id` string. If the AS puts anything else in `sub` (e.g. a prefixed or namespaced id), the equality gate fails **100% of the time**. State "`sub` == `auth.users.id` verbatim" as a contract on the AS.
5. **Scope enforcement — per-request, derived from the tool (do NOT ship the static `notes:read`-only option).** The verifier enforces `requiredScopes` as one **flat set per request** (`McpOAuthVerifier.swift:211-213`) with no per-tool notion, and dispatch does **not** re-check scope. If OAuth required only `notes:read`, then a `notes:read`-only token could reach write tools whenever the native "Allow writes" toggle is on — meaning `notes:write` would be **advertised but never enforced**, and "read-only" consent would be meaningless for writes. Therefore:
   - Derive `requiredScopes` **per request from the tool's `requiresWrites` flag** (`McpToolCatalog.swift`): write tools (`create_note`, `update_note_content`) require `notes:write`; read tools require `notes:read`. Pass a tool-appropriate config into `verify()` for each call — or enforce write-scope membership at dispatch from the threaded `McpAccessToken.scopes`. Either way this **depends on the step-4 restructure**: today `verify()` runs inside `authorize()` before the request body is parsed, so the tool is not yet known at verification time.
   - **Both gates are required for writes (AND, not OR):** the OAuth `notes:write` scope **and** the native `writesEnabled` UserDefaults toggle must both be satisfied. Neither alone authorizes a write. (§10 Q5 downgraded to "confirm UX wording for the two gates," not "choose whether to enforce scope.")
6. **Keep bearer dual-mode.** No change needed — `authorize()` already accepts the legacy token when `oauth != nil` (264–265). This is what keeps existing users working during rollout. Verify at rollout that a legacy token still works (including lowercase `bearer`, per audit nuance).
7. **`iat` not validated** — decide whether to add a max-token-age check (§10 Q6). Not required for launch given short TTL + PKCE + single-use codes.

---

## 5. Settings / UX changes (web-app, new Mac release)

Current MCP settings (`web-app/components/settings/mcp-server-setting.tsx`) expose three controls (Enable, Allow writes, Access token Reveal/Regenerate), all driven by the bearer-only `McpServerStatus` (`shared/native-bridge/src/contract.ts:190`, which has **no OAuth fields**). `buildMcpClientConfigs()` (`mcp-client-config.ts:23`) generates bearer snippets for four clients (Claude Code, Codex, VS Code, Cursor); tests lock the bearer contract (`mcp-client-config.test.ts`).

Changes:
- **Keep bearer controls during rollout** (Reveal/Regenerate stay — dual-mode). Do not remove them until bearer is deprecated.
- **Rewrite the Codex snippet in `buildMcpClientConfigs()` for OAuth; do NOT flip the other clients on faith.** The Codex snippet becomes a `codex mcp login …` flow (drop the `export NERD_OUT_MCP_TOKEN` + `--bearer-token-env-var`) — Codex is the only client Phase 0 (§7) actually verifies. **Keep the bearer snippets for Claude Code, VS Code, and Cursor** until each client's MCP OAuth behavior against this AS is verified separately (their discovery/login flows differ; a broken snippet is worse than a legacy one). When a client is verified, drop its `Authorization` header/`headers.Authorization` block then. Update `mcp-client-config.test.ts` per client as each flips. **Decision (§10):** emit OAuth-only, or emit both bearer + OAuth snippets during transition.
- **Authorized-clients / consent management (new).** There is no UI today to view or revoke granted clients. Add a view that lists `OAuthGrant` rows for the signed-in user with per-client **revoke** (sets `OAuthGrant.revokedAt`, which invalidates refresh tokens). This requires extending `McpServerStatus`/the bridge contract or a new web route reading grants via `createAdminClient()`.
  - **Revoke-latency is a documented UX property, not a silent gap.** There is **no access-token denylist by design** — revoke invalidates the *refresh* token immediately, but any already-issued access JWT keeps working until its `exp`. Because access-token TTL is a hard **≤ 5 min** constant (§3.7), that residual window is bounded. **Surface this in the revoke UI** ("access ends within ~5 minutes") so a user clicking "revoke" isn't misled into expecting instant cutoff.
- **Optional scopes display.** `scopes_supported` is advertised but `McpServerStatus` has no `scopes` field; surfacing scopes needs a contract extension.

---

## 6. Plugin change (`recall-plugins`) — the minimal diff

Gated on §9 steps A–E (app AS live + Phase 0 passed). Expect ~4 files. Note this plugin is installed via `npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall-notes --plugin --global` (a marketplace install, **not** a `.claude`-style install) — this matters for the login-name question (§7).

### 6.1 `plugins/recall-notes/.mcp.json` — remove `bearer_token_env_var`
**Before:**
```json
{
  "mcpServers": {
    "recall-notes": {
      "type": "http",
      "url": "http://127.0.0.1:38473/mcp",
      "bearer_token_env_var": "NERD_OUT_MCP_TOKEN"
    }
  }
}
```
**After:**
```json
{
  "mcpServers": {
    "recall-notes": {
      "type": "http",
      "url": "http://127.0.0.1:38473/mcp"
    }
  }
}
```
Add an OAuth field **only if Phase 0 proves one is required.** Verified Codex HTTP-server keys are `url` (required), `type`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, plus two **optional** per-server OAuth keys that exist in the config reference and the codex 0.130.0 binary's config parser: `oauth_resource` ("Optional RFC 8707 OAuth resource parameter to include during MCP login") and `scopes` (scopes to request when the server doesn't advertise `scopes_supported`). **Default posture: set neither** — the server `url` is the resource and PRM discovery supplies scopes; add `oauth_resource` only if Phase 0 shows discovery mis-derives the resource (§7). OAuth callback keys (`mcp_oauth_callback_port`, `mcp_oauth_callback_url`) are **top-level** config, not per-server — do not put them in `.mcp.json`.

### 6.2 `plugins/recall-notes/README.md` — rewrite setup to the login flow
Replace the "Reveal token / `export NERD_OUT_MCP_TOKEN`" section with:
1. Install: `npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall-notes --plugin --global` (same command users already use).
2. Open Recall for Mac → Settings → MCP Server → enable.
3. `codex mcp login <verified-name>` (use the **verified** name from Phase 0 — plain `recall-notes` vs. a marketplace/plugin-namespaced form) → browser sign-in + consent.
4. Start a new Codex thread; no token export needed.
5. **Collapsed "Legacy token setup"** `<details>` section for users on older app builds during rollout (server still accepts bearer).
6. Update the troubleshooting note that currently references `NERD_OUT_MCP_TOKEN`.

### 6.3 `plugins/recall-notes/.codex-plugin/plugin.json` — bump version
`"version": "0.1.0"` → `"0.2.0"`.

### 6.4 `plugins/recall-notes/skills/recall-notes/SKILL.md` — update token references
The current SKILL.md **does** reference the token (Setup Checks bullet "Codex must have `NERD_OUT_MCP_TOKEN` set…" and the authorization-error troubleshooting guidance). Update these to the `codex mcp login` flow. (Prior brief said "unlikely to need changes" — it does need a small edit.)

---

## 7. Phase 0 — end-to-end verification (against a live OAuth Mac build)

**Do this before publishing the plugin.** Requires a Mac build where `currentOAuthConfig()` returns non-nil (§4) and the AS (§3) is deployed over HTTPS.

1. Make a scratch copy of the plugin with `bearer_token_env_var` removed and install it **the real way** — `npx codex-marketplace add NerdOutInc/recall-plugins/plugins/recall-notes --plugin --global` (pointed at the scratch copy / a fork) — so the test matches how users actually install, including any server-name namespacing the marketplace applies.
2. `codex mcp login <name>` → confirm a browser opens, Supabase sign-in + consent completes, Codex stores a token.
3. Fresh Codex thread: exercise `list_notes`, `read_note`, keyword + semantic search, index status, collaborators; with "Allow writes" on, `create_note` / `update_note_content`.
4. Confirm **refresh** (token auto-renews) and **revoke** (revoke the grant in-app/AS → Codex re-prompts; note the ≤5-min access-token residual window from §5).

**Unknowns to resolve and record before publishing:**
- **Unknown 1 — Login server name:** is it `recall-notes` (plain) or a plugin/marketplace-namespaced form? Codex plugin server policy lives under `[plugins."<plugin>".mcp_servers.<server>]` in `config.toml`, so a marketplace-installed plugin may namespace the server differently from a local `.mcp.json`. Because this plugin is installed via `codex-marketplace add` (§6), test the login name **on a marketplace install specifically**, not a hand-copied `.mcp.json`. Update README with whatever actually works. *Note the naming split already in the tree:* the plugin declares its server as `recall-notes` (`.mcp.json`), but the web app's own manual client-config generator (`buildMcpClientConfigs`, `mcp-client-config.ts:35`) emits `codex mcp add recall …` — i.e. the non-plugin path uses the server name **`recall`**. Don't assume the two agree; the plugin's `login` name is whatever the marketplace-installed `.mcp.json` server key resolves to, which Phase 0 must confirm empirically.
- **Unknown 2 — Callback port:** does Codex's default ephemeral loopback port work (it should, if the AS accepts any loopback port per RFC 8252 §7.3 with the literal-host allowlist — §3.3/§3.4), or must the user set a fixed top-level `mcp_oauth_callback_port` / `mcp_oauth_callback_url`? Document only if a fixed port is genuinely required.
- **Unknown 3 — Does removing `bearer_token_env_var` alone switch Codex to OAuth?** (A `.mcp.json` with `bearer_token_env_var` set never tries OAuth.) Confirm no additional documented opt-in key is needed. **Do not invent config keys.**
- **Unknown 4 — Discovery chain / where Codex fetches PRM (blocks the §3.2 native-only decision).** Confirm the exact order and origin: does Codex fetch `/.well-known/oauth-protected-resource` from the **resource** (loopback server) first, follow `authorization_servers[0]` to the AS, then fetch `/.well-known/oauth-authorization-server` from the **AS** origin? If instead Codex expects PRM at the AS origin, native-only PRM breaks and we must add a web-side PRM route (§3.2). Verify **which** well-known URL is fetched first and from which origin before committing to native-only PRM.

**`oauth_resource` key — exists, but do not use by default:** the prior brief flagged `oauth_resource` / `--oauth-resource` as likely-nonexistent. Verified 2026-07-01: the per-server config key **does exist** — the Codex config reference documents `mcp_servers.<id>.oauth_resource` ("Optional RFC 8707 OAuth resource parameter to include during MCP login"), and the key (with `scopes`) is present in the installed codex 0.130.0 binary's MCP config parser (`RawMcpServerConfig`). The `--oauth-resource` **CLI flag** is gone. Default posture: **leave it unset** — the RFC 8707 resource should be the server `url`, handled by discovery during `login`. Phase 0 must additionally test whether the plugin `.mcp.json` **accepts** `oauth_resource`, so we know the escape hatch works if discovery mis-derives the resource (relevant given the exact-`aud` hard requirement in §3.5).

If Phase 0 shows the plugin path can't cleanly do OAuth, **STOP and report** — fallback is to keep the bearer plugin and document manual `config.toml` OAuth setup.

---

## 8. Rollout & ordering

- **Dual-mode means bearer users keep working.** `authorize()` accepts the legacy token whenever `oauth != nil`, so shipping OAuth in a new Mac build does not break anyone still on the bearer plugin (`0.1.0`).
- A single `.mcp.json` entry **cannot** offer both: if `bearer_token_env_var` is present Codex uses the token and never tries OAuth. So the switch is **per-plugin-version** (`0.1.0` bearer → `0.2.0` OAuth).
- Sequence: (1) land the plugin change on a **branch / draft PR and HOLD**; (2) ship + deploy the app AS integration in a **released** Mac build; (3) complete **Phase 0** on that build; (4) merge + publish `0.2.0` and update the marketplace listing.
- Consider a short transition window documenting both paths (collapsed legacy section in README).

---

## 9. Sequenced, dependency-ordered task list

**A. Web-app authorization server (`nerd-out-app`) — the blocker**
- [ ] Add `jose` + AS env vars (`OAUTH_ISSUER` **fixed constant**, `OAUTH_SIGNING_PRIVATE_JWK`, `OAUTH_SIGNING_KID`, access-token TTL ≤5min, refresh TTL) to `env.mjs`; confirm dev/prod issuer values (§3.7, §10 Q1).
- [ ] Implement ES256 signing-key generation/storage/**publish-before-sign** rotation; seed `OAuthSigningKey` (public JWK) rows; encode overlap-in/overlap-out timing constants (§3.7, §10 Q4/Q7).
- [ ] `GET /.well-known/oauth-authorization-server` (RFC 8414) incl. documented omission of revocation/introspection (§3.1).
- [ ] `GET /oauth/jwks` — **HTTPS**, short cache (§3.6).
- [ ] `POST /oauth/register` (RFC 7591 DCR) — literal loopback-host allowlist, per-IP rate limit (§3.3).
- [ ] `GET /oauth/authorize` + consent Server Component + Supabase login redirect — PKCE S256, required+exact `redirect_uri` (loopback, port-only variance), RFC 8707 resource, per-IP + per-client rate limit (§3.4).
- [ ] `POST /oauth/token` — auth-code+PKCE with **`client_id`/`redirect_uri`/`resource` equality + required `code_verifier` + atomic single-use**; refresh rotation + reuse detection; **`aud` = exact loopback URI**; `sub` = Supabase uid verbatim; per-client + per-IP rate limit (§3.5).
- [ ] Adjust `proxy.ts` matcher for `/oauth/*` (§3.9).
- [ ] GC sweeper for expired+consumed codes, expired+consumed+revoked refresh tokens, old revoked grants, expired rate-limit rows (§3.8).
- [ ] Confirm PRM `authorization_servers` == AS issuer; decide PRM stays native **pending Phase 0 discovery-chain check** (§3.2, §7 Unknown 4, §10 Q2).

**B. Native Mac-app cutover (`nerd-out-app`)**
- [ ] **Step 0 gate:** check out real `origin/main` HEAD; confirm the merged superset seam (§2.0 items 1–5) coexists before any wiring.
- [ ] Build the native out-of-band JWKS fetcher + cache — **HTTPS-only**, TTL `T_native`, last-good fallback, OAuth-off (not brick) on cold fetch failure → populate `McpJwks` (§4.1).
- [ ] Wire `currentOAuthConfig()` to a live `McpOAuthConfig` (fixed issuer / exact-loopback resource / per-request scopes / jwks / clockSkew) (§4.2).
- [ ] **Restructure native auth to thread the verified token** — change `authorize()`/`validate()` to return the `McpAccessToken` instead of discarding it (today auth runs before the JSON-RPC parse and drops the claims); then rewire `handleToolCall`: parse `tools/call` → resolve the tool → enforce per-tool scope → call `mcp_dispatch_tool` with `{toolName: tool.webMethod, arguments, user:{id: token.subject}}` (web-method key, not the public MCP name); map dispatch identity-mismatch throw to `invalidAuthorization` 401 (§4.4).
- [ ] Implement **per-tool** scope enforcement (`notes:write` for `requiresWrites` tools) + AND with `writesEnabled` toggle (§4.5).
- [ ] Verify bearer dual-mode still works, incl. lowercase `bearer` (§4.6).

**C. Settings / UX (`nerd-out-app` web-app)**
- [ ] Rewrite the **Codex** snippet in `buildMcpClientConfigs()` for OAuth; **keep bearer snippets for Claude Code / VS Code / Cursor** until each client's OAuth flow is verified separately; update `mcp-client-config.test.ts` per client as each flips (§5).
- [ ] Add authorized-clients/consent management (list `OAuthGrant`, per-client revoke) + contract extension; surface **≤5-min revoke-latency** copy (§5).
- [ ] Keep bearer Reveal/Regenerate controls during rollout (§5).

**D. Release**
- [ ] Ship a **released** Mac build with A+B+C live and installable on the test machine (AS reachable over HTTPS).

**E. Plugin verification (`recall-plugins`)**
- [ ] Phase 0 end-to-end against the released build via a **marketplace install**; record Unknowns 1–4 (§7).

**F. Plugin change (`recall-plugins`) — on a HOLD branch**
- [ ] `.mcp.json`: remove `bearer_token_env_var` (§6.1).
- [ ] `README.md`: rewrite to `codex mcp login <verified-name>` + real `codex-marketplace add` install + collapsed legacy section + troubleshooting (§6.2).
- [ ] `plugin.json`: `0.1.0` → `0.2.0` (§6.3).
- [ ] `SKILL.md`: update token references to login flow (§6.4).
- [ ] Commit as `Brian Pattison <brian@brianpattison.com>`, **no** AI attribution. Mark PR "hold — do not publish until app OAuth is live."

**G. Publish**
- [ ] After A–E verified: merge `0.2.0`, update marketplace listing. Ask the human before publishing/merging to `main`.

---

## 10. Risks & open questions for the human

> Note: several items the prior draft listed as open questions are now **stated requirements** in §3–§4 (audience exactness, fixed issuer, per-tool scope, rotation mechanics, redirect-uri binding). What remains below is genuinely undecided or needs a human value/confirmation.

1. **Issuer constant values.** `iss` is a **fixed `OAUTH_ISSUER` env var, never request-derived** (settled, §3.7). Open: the concrete dev vs prod values (current Vercel host vs. future `nerdout.com`) and the plan to change them without stranding tokens.
2. **PRM location.** Keep RFC 9728 PRM native (recommended) — **contingent on Phase 0 Unknown 4** confirming Codex fetches PRM from the resource first. If not, add a web-side PRM route.
3. **`resource`/`aud` value — CONFIRM THE CONSTANT.** Settled that `aud` MUST equal `http://127.0.0.1:38473/mcp` byte-for-byte (§3.5 hard requirement). Open only: that `38473` has a single source of truth shared by the AS and the native `config.resource`, and that Codex's discovered `resource` matches.
4. **Signing-key storage.** Env-var private JWK (recommended) vs. encrypted-in-DB. `OAuthSigningKey` stores public-only by design.
5. **Scope UX.** Per-tool enforcement (`notes:write` for write tools) is **required** (settled, §4.5). Open: UX wording for the two independent write gates (`notes:write` scope AND `writesEnabled` toggle) so users understand both must be on.
6. **`iat` / max-token-age.** The verifier ignores `iat`. Acceptable given short TTL + PKCE + single-use codes, or add a sanity check?
7. **JWKS rotation timing values.** Publish-before-sign is **required** (settled, §3.7). Open: the concrete `T_native` cache TTL, the overlap-in margin, and the overlap-out window (`accessTokenTTL + clockSkew`) — pick values and record them in both repos.
8. **Access-token TTL value.** Set to **≤5 min** (settled rationale: no denylist, bounded revoke latency, TTL ≫ 60s skew). Confirm the exact number.
9. **Codex plugin-server login name & callback port & discovery chain** — Unknowns 1–4, unresolved until Phase 0 (§7); the make-or-break unknowns for the plugin change.
10. **Is the app AS phase live in a released Mac build yet?** If not, the plugin task is blocked at Phase 0. (Also: has `origin/main` actually merged all of #126/#127/#128 as the superset — §2.0 gate?)

---

### Corrections to the prior brief
- **#126/#127/#128 are MERGED to `origin/main`**, not "Done / in review." (Inert characterization is correct.) **The canonical tree is the post-merge superset (#128 last); the #127-audited worktree was a *pre-#128* snapshot with no `currentOAuthConfig` and a bearer-only `validate()` — that is not `origin/main` today.** A §4-step-0 gate re-confirms the merged seam before any native wiring (§2.0).
- **#127's `mcp_current_user` / `mcp_dispatch_tool` are TypeScript web-methods**, not Swift bridge methods; PR #127 touches **zero** `apple-app/` files. `BridgeRouter+Mcp.swift` is unchanged.
- **`currentOAuthConfig()` belongs to #128**, not #127 (the brief lists it under the bridge PR context).
- **SKILL.md does need editing** — it references `NERD_OUT_MCP_TOKEN` in Setup Checks and troubleshooting (brief said "unlikely to need changes").
- **The web-app middleware entrypoint is `proxy.ts`, not `middleware.ts`** (Next 16 rename), and `/oauth/*` is currently *not* excluded from session refresh.
- **The brief under-scopes the app work:** it frames the change as "small," but the AS (§3), the native JWKS fetcher + dispatch rewire (§4), and the settings/consent UI (§5) are all substantial and entirely unbuilt — the plugin diff is trivial only *after* all of that ships.
- **`oauth_resource` IS a real (optional) Codex per-server key** — documented in the config reference and present in the codex 0.130.0 binary's config parser, alongside a per-server `scopes` key; only the `--oauth-resource` CLI flag is gone. Do not use it by default (the server `url` is the resource via discovery), but Phase 0 should confirm the plugin `.mcp.json` accepts it as an escape hatch (§7). *(This corrects both the prior brief's original reference and this plan's first draft, which over-claimed "no such field" from the `/codex/mcp` page alone.)*
- **The plugin installs via `codex-marketplace add` (marketplace), not a `.claude`-style install** — Phase 0 must test the login server name on a real marketplace install, since namespacing may differ from a local `.mcp.json` (§7 Unknown 1).
