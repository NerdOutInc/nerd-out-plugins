# Task: migrate the `recall` Codex plugin to MCP OAuth

> **Superseded (2026-07-01).** This brief has been replaced by
> **[`docs/oauth-migration-plan.md`](./oauth-migration-plan.md)** — a full
> end-to-end plan grounded in a code audit of `NerdOutInc/nerd-out-app` at
> `origin/main` and re-verified Codex docs/binary behavior.
>
> Do not work from this file. Notably, the old text here claimed there was no
> documented `oauth_resource` config key; that was wrong (it exists as an
> optional per-server key — see the plan's §7 for the correct guidance), and
> several other details (PR states, SKILL.md impact, middleware entrypoint)
> were corrected in the plan.
