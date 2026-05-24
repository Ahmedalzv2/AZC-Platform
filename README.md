# AZC Platform

Single-page trading dashboard centered on a US100 ICT cockpit plus a
separate Spot Watch lane for crypto accumulation/distribution context.
US100 is manual planning only: session, liquidity sweep, MSS/CHoCH,
entry model, invalidation, and next action. Crypto assets are for
buy-low / sell-high monitoring, news context, and zone alerts.

Auto-fire is disabled after OOS research found no positive-EV crypto
scalp configuration. Live execution controls remain for supported manual
futures lanes only; US100 never routes through them.

Hosted on GitHub Pages — open `index.html` directly or visit the live
URL: <https://ahmedalzv2.github.io/AZC-Platform/>.

## Files

| File          | Role                                                       |
|---------------|------------------------------------------------------------|
| `index.html`  | Main dashboard. US100 cockpit + Spot Watch + app logic.    |
| `styles.css`  | Theme + layout. Linked by `index.html`.                    |
| `us100.html`  | Standalone US100 (NASDAQ) futures view.                    |
| `worker.js`   | Cloudflare Worker that proxies signed MEXC contract calls. |
| `tests/`      | Node-native test suite (`npm test`, ~2s).                  |
| `CLAUDE.md`   | Operating manual for the Claude Code agent.                |
| `AGENTS.md`   | Operating manual for Codex and other coding agents.        |

## Agent coordination

Codex and Claude Code both work on this repo. Before changing anything,
read `AGENTS.md`, `CLAUDE.md`, recent commits, and open PR notes so both
agents stay aligned on current policy, shipped work, and known risks.
If one agent changes trade policy, live-order behavior, tests, or repo
workflow, update both manuals in the same PR.

## Deploy

The browser app is static — push to `main` and GitHub Pages serves it.
The Worker deploys separately to Cloudflare (see header comment in
`worker.js` for steps).

## Tests

```sh
npm test
```

Tests are pure JS, no build step. Run before every push.
