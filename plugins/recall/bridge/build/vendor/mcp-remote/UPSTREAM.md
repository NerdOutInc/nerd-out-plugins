# Vendored mcp-remote source

This directory contains the source from `mcp-remote@0.1.38`, upstream commit
`02619aff36e79803d7c894e8c8ae7b34b2d11f8c` (MIT).

Recall carries a deliberately small source patch for:

- structured authorization-URL handoff without opening a browser;
- state-bound approval and denial callbacks;
- cross-process OAuth credential mutation ownership;
- atomic mode-0600 credential replacement; and
- deterministic cleanup of PKCE verifier and lock state.

The build uses patched compatible releases of the MCP SDK and transitive HTTP
tooling rather than freezing the upstream 2025 dependency graph with known
security advisories. Source and protocol compatibility are covered by the
vendored upstream suite plus Recall's coordinator and live-race tests.

`bridge/build/build.mjs` generates both the normal proxy and Recall's OAuth
coordinator from this tracked source. CI rebuilds and byte-compares every
committed generated artifact; the bundles must never be edited directly.
