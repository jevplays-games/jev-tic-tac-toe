<p align="center"><img src="assets/banner.jpg" alt="Pixel-art robot Jev playing tic-tac-toe with glowing cyan X and magenta O marks in a neon arcade" width="100%"></p>

# JEV Arcade · Tic-Tac-Toe

A complete vanilla HTML/CSS/JavaScript game with a real TypeSafe/JEV adapter, an authoritative backend, Discord OAuth and community launch grants, verified leaderboards, replay evidence, and exhaustive rules-space analytics.

**No browser or server runtime packages are required for the native local server.** The local runtime uses Node's built-in HTTP, Fetch, Web Crypto, and SQLite APIs. Cloudflare deployment uses a Worker, Static Assets, and D1.

## Start locally

Requires **Node 22.16.0 or newer**. The package was tested on Node 22.16.0; that version emits an experimental warning for its built-in SQLite module.

```powershell
# Windows PowerShell, after extracting the ZIP:
cd jev-tic-tac-toe
Copy-Item .env.example .env
npm start
```

```sh
# macOS / Linux:
cd jev-tic-tac-toe
cp .env.example .env
npm start
```

Open **http://localhost:8787**. There is no `npm install` step for local gameplay.

Without credentials, the game works against a **clearly labeled perfect-play fallback**. This is not JEV, is not a fabricated model response, and never produces official JEV leaderboard results. Browser-only practice is also available when the API cannot be reached after the page assets have loaded; the application does not install a service worker or promise offline loading of uncached assets.

### Enable actual JEV

Set the following in `.env`, then restart the server:

```dotenv
TYPESAFE_API_KEY=your-private-key
PINNED_JEV_MODEL=jev-1.13.0
```

The key remains server-side. The adapter calls `POST https://api.typesafe.ai/v1/systemone` with the documented `model`, `state`, and `questions` shape. The four profiles change inputs and questions, not the rules:

| Profile | Model inputs / selection |
|---|---|
| Easy | Board and every legal action; one move Choice |
| Normal | Immediate win / threat facts; one move Choice |
| Hard | Fork facts and bounded human-reply summaries; one move Choice |
| JEV | Hard inputs plus a win/draw/loss Choice per candidate; maximize the model's predicted utility |

Normal play is selected by JEV, **not silently corrected by minimax**. Exact minimax is used after selection for evaluation and as the visibly labeled fallback. The intended strength ordering is unverified until live benchmarks are run. Model confidence is not an independently calibrated game-winning probability.

### Enable Discord and ranked play

See [the deployment guide](docs/DEPLOYMENT.md) for Discord application setup, the callback URL, `/play tic-tac-toe`, and Cloudflare deployment. Credentials are configuration tasks, not hard-coded placeholders in the game logic.

Authentication uses `identify` only. Guild installation uses `applications.commands`. Signed Discord interactions issue a five-minute, single-use, user-bound launch code that grants fifteen minutes of verified guild/channel context. No persistent Gateway process or runtime bot token is required by this implementation.

Ranked matches require a signed-in account and an actual configured JEV service. Guest matches are never converted retroactively into ranked games. A server-side fallback or recovery audit gap permanently removes that match from official rankings.

## What is implemented

- Responsive single-page game, all four profiles, human X/O selection, keyboard controls, rules/privacy dialogs, and structured decision evidence.
- Immutable rules, legal-action generation, exact reference evaluator, postgame replay controls, request/response inspection, and JSON/CSV exports.
- Authoritative match creation and actions, optimistic revision checks, decision leases, idempotency receipts, crash-safe request preparation, expiry, resumption, and replay verification.
- Discord OAuth state validation, session rotation, CSRF protection, Ed25519 interaction verification, personal launch grants, and scoped leaderboards.
- Account/session analytics, source separation, profile/model/mark cohorts, per-ply quality, move-frequency maps, latency distributions, tactical opportunities, outcome calibration, token/billing coverage, and anonymous operational counters.
- Offline exhaustive audit, complete state/edge corpus, independent bitboard reference tests, seeded baseline benchmarks, resumable live benchmark tooling, and frozen-policy adversarial evaluation.

## Analytics and integrity

Every accepted move records its legal alternatives, exact before/after value, optimal set, minimax regret, immediate-win/block opportunities, fork features, source, and timestamps. A JEV decision additionally retains the exact structured request, allowlisted response, model ID, probabilities, confidence, input hash, retry attempts, latency, and reported token usage.

A per-match SHA-256-linked event sequence connects the manifest, prepared requests, results, accepted actions, completion, and verification. Exports can be independently replayed and checked without contacting JEV or Discord.

**Hash links are not signatures.** Anyone able to rewrite an entire export can recalculate the chain. Retain a trusted head hash or original export for meaningful tamper comparison. The server's private authoritative match records—not user-imported files—establish leaderboard eligibility.

The dashboard uses at most the latest **500 closed matches**, explicitly reports truncation, and separates observation sources. “Export all my matches” follows history pagination without a 500-match cap. Browser-only practice is labeled untrusted and excluded from server account analytics.

Read [the complete analytics dictionary](docs/ANALYTICS.md) for every metric, denominator, limitation, and export format.

Measured release results, including all three exhaustive offline baselines, are in [verified results](docs/VERIFIED-RESULTS.md).

## Verify the implementation

```sh
npm test
npm run check
npm run audit
```

The packaged audit confirms:

| Reference measurement | Count |
|---|---:|
| All raw 3-state cell assignments | 19,683 |
| Reachable boards | 5,478 |
| Nonterminal reachable boards | 4,520 |
| Rotation/reflection classes | 765 |
| Legal state-transition edges | 16,167 |
| Complete legal games, stopping on first terminal result | 255,168 |

These counts describe the rules, **not JEV's measured strength**. `npm test` independently cross-checks the evaluator using a separate bitboard implementation on every reachable board and legal edge.

```sh
# Verify a completed match export, or the all-matches export:
npm run verify-export -- path/to/export.json
```

[Testing and verification details](docs/TESTING.md) identify exactly which paths were exercised, including the browser test transport limitation and the absence of real provider/OAuth credentials during packaging.

## Benchmark independently of the UI

```sh
# Every nonterminal position, offline exact baseline:
node bench/run.js --mode positions --source minimax --limit 4520 --out bench-runs/minimax

# Scripted baselines:
node bench/run.js --mode positions --source tactical --limit 4520 --out bench-runs/tactical
node bench/run.js --mode positions --source random --limit 4520 --seed 20260922 --out bench-runs/random

# Alternating X/O, no external calls:
node bench/run.js --mode games --source minimax --opponent random --limit 200 --out bench-runs/games

# LIVE JEV: explicitly authorized, bounded, paid API calls.
# Set TYPESAFE_API_KEY in the shell, or use Node's --env-file-if-exists=.env option.
node --env-file-if-exists=.env bench/run.js --source jev --mode positions --profile jev --limit 100 --max-calls 100 --confirm-live --out bench-runs/live-pilot

# Same arguments and source revision, plus --resume:
node --env-file-if-exists=.env bench/run.js --source jev --mode positions --profile jev --limit 100 --max-calls 100 --confirm-live --out bench-runs/live-pilot --resume

# Worst-case opponent against a complete, recorded, frozen repeat-0 policy:
node bench/exploitability.js bench-runs/minimax X
```

For a complete live position evaluation, use `--limit 4520` with a deliberately chosen call budget. At most two transport attempts are made per model decision; single-legal-action positions need no API call. `--repeats`, `--seed`, and `--split development|validation|test|all` support replication and symmetry-grouped splits. Never tune on the held-out test partition and then claim independent performance there.

Uncommitted live requests prevent automatic resume: the harness will not silently re-sample potentially completed inference. Preserve the interrupted run and use a new output directory. Offline baselines and fallback results always have distinct source labels.

## Repository map

```text
public/                 single-page UI, pure rules, policy, oracle and analysis
server/                 portable Worker-style backend, auth, JEV, reports
local/                  Node HTTP + built-in SQLite / D1-compatible adapter
migrations/             database schema
bench/                  corpus audit, benchmark runner, frozen policy evaluation
scripts/                export verification, source manifest, Discord command setup
tests/                  exhaustive rules, API/security, adapter, analytics, browser
reports/                generated audits, baseline runs, tests and screenshots
docs/                   architecture, analytics, API, deployment and sources
wrangler.jsonc          Cloudflare deployment configuration
```

Local data lives in `.data/game.sqlite` and is not included in the ZIP. Secrets, databases, dependency directories, and private browser sessions are excluded from the package.

## Release notes and boundaries

No live TypeSafe quality claim, real Discord login, or production Cloudflare deployment was made during packaging. Their actual credentials and target account are required to perform those external smoke tests. Source and contract tests are not a substitute for that final staging check.

The server verifies its game and opponent, but cannot establish that a human avoided an external solver. Do not advertise the leaderboard as cheat-proof or use it for cash-prize competitions. See [security boundaries](docs/SECURITY.md).
