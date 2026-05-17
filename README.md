# ICT AutoPilot

Single-page trading dashboard for ICT (Inner Circle Trader) setups across
crypto, futures, and US100. Current policy is manual execution only:
auto-fire is disabled after OOS research found no positive-EV crypto
scalp configuration. The dashboard still shows signals, fire status,
spot zones, live positions, and manual Force Fire controls.

Hosted on GitHub Pages — open `index.html` directly or visit the live
URL: <https://ahmedalzv2.github.io/ict-autopilot/>.

## Files

| File          | Role                                                       |
|---------------|------------------------------------------------------------|
| `index.html`  | Main dashboard. All app logic + UI.                        |
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
