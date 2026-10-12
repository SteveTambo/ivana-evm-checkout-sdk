# Changelog

## 0.1.0 (2026-10-12)

First release: USDC checkout on Base and Polygon through IVANA.

- Server client (`/server`): networks, payment intents, status, verify and the settlement feed, all with the tenant API key; refuses to run in a browser.
- Browser: EIP-6963 wallet discovery (Phantom first), connect-then-switch with numeric chain ids, funds check, and `payIntent`.
- `payIntent` sends only unpaid transfers, saves each hash at once, resends only a reverted transfer, records a wallet batch before requesting it, and never pays an expired, held or completed payment again.
- No runtime dependencies.
