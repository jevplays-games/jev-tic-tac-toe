# Deployment and credential setup

## Local runtime

Node 22.16.0+ is required. Copy `.env.example` to `.env`, edit it, and run `npm start`. This listens on loopback by default and creates `.data/game.sqlite`. Restart after changing environment variables or backend modules. There is no hot-reload process.

`PUBLIC_ORIGIN` must match the browser origin exactly, including the port. Default: `http://localhost:8787`. For a different port, set both `PORT` and `PUBLIC_ORIGIN`. The development cookie is intentionally non-Secure for loopback HTTP. **Do not expose the native development server publicly**; use the HTTPS Worker deployment below.

Local state is ordinary SQLite. Stop the process before making a simple file copy, or use SQLite's backup mechanism. The WAL file can hold uncheckpointed changes; copying only the live main file is not a reliable backup.

## Discord application

1. Create a Discord developer application. Record application/client ID, public verification key, and client secret.
2. Add the exact OAuth redirect `https://YOUR_HOST/api/auth/discord/callback`. For permitted local testing also register `http://localhost:8787/api/auth/discord/callback`. Discord must accept the exact chosen redirect; use HTTPS staging where local callbacks are not accepted.
3. Set the application to support guild installation with the `applications.commands` scope. User sign-in remains a separate authorization-code flow with `identify` only.
4. Configure the HTTPS interactions endpoint `https://YOUR_HOST/api/discord/interactions`. The endpoint must be publicly reachable for Discord's signed verification ping. A loopback server cannot receive that ping directly; use the staged Worker deployment.
5. Set `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_PUBLIC_KEY` in the server configuration.
6. Run `npm run discord:register` from a local shell with those credentials. The script uses a short-lived client-credentials token scoped to `applications.commands.update`, then POSTs/upserts only the `play` command. It does not bulk-replace unrelated commands or keep a runtime bot token.
7. Install the application into a participating server and configure command access through Discord's integration permissions. Run `/play tic-tac-toe` in the intended channel.

The command returns an ephemeral personal URL. The app authenticates the original invoking user, then the browser redeems the pending code with a CSRF-protected POST. Another Discord account cannot redeem it. Codes expire after five minutes; attributed context expires fifteen minutes after issuance. A match snapshots the valid context at its start.

This proves the initiating user's guild/channel participation **at launch**. It does not continuously recheck membership or detect removal instantly. Historical matches retain their original context. Fresh community leaderboard access requires a currently valid launch grant.

## Cloudflare Worker + Static Assets + D1

Cloudflare tooling is a deployment-only dependency, deliberately not installed by `npm start`. Install or invoke an approved current Wrangler release and pin that CLI version in your deployment environment. The commands below use `npx wrangler` for clarity.

```sh
npx wrangler login
npx wrangler d1 create jev-arcade
```

Copy the returned database ID into `wrangler.jsonc`. Set `vars.PUBLIC_ORIGIN` to the actual HTTPS Worker/custom-domain origin. This must not retain the example placeholder. Set the Discord application ID/public key as Worker variables or secrets.

Create private secrets:

```sh
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put RATE_LIMIT_SALT
# Optional, separate read-only operations-dashboard credential:
npx wrangler secret put ADMIN_ANALYTICS_KEY
```

Generate the rate-limit salt and optional operations key using cryptographically random bytes. Do not use the example string. Example local generator:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Prepare and deploy:

```sh
node scripts/build-manifest.js
npm test
npm run audit
npx wrangler d1 migrations apply jev-arcade --remote
npx wrangler deploy
```

The Worker serves `/api/*`, while static assets use the asset binding and `_headers`. A one-minute scheduled handler expires abandoned matches and removes expired sessions/launch grants, old rate buckets, and operational counters older than 30 days. D1 and API quotas depend on the chosen hosting plan; set application limits accordingly.

The deployment file has no actual account/database IDs, secrets, or custom domain. Nothing in the ZIP has been deployed to your account.

## Runtime configuration

| Variable | Default / purpose |
|---|---|
| `PUBLIC_ORIGIN` | Exact browser origin; required |
| `PINNED_JEV_MODEL` | `jev-1.13.0`; must be an explicit `jev-x.y.z` version |
| `TYPESAFE_API_KEY` | Empty means labeled fallback only |
| `DISCORD_APPLICATION_ID` | Application/client ID |
| `DISCORD_CLIENT_SECRET` | Server-only OAuth credential |
| `DISCORD_PUBLIC_KEY` | Ed25519 interaction verification key |
| `RATE_LIMIT_SALT` | Required production secret; rate keys hash source + bucket + salt |
| `MAX_JEV_CALLS_PER_DAY` | 5,000 global provider attempts, including retries |
| `JEV_CALLS_PER_HOUR` | 300 per account/current guest session |
| `MATCHES_PER_HOUR` | 60 per account/current guest session |
| `SESSION_CREATIONS_PER_HOUR` | 60 per origin IP bucket |
| `API_REQUESTS_PER_MINUTE` | 600 per origin IP bucket; tune shared-network behavior |
| `INPUT_PRICE_PER_MILLION` | Optional operator assumption; blank means unknown |
| `OUTPUT_PRICE_PER_MILLION` | Optional operator assumption; blank means unknown |
| `ADMIN_ANALYTICS_KEY` | Optional separate credential for anonymous operational reports |

Per-session API admission is additionally limited to 240 calls/minute. Abuse counters use salted hashes; raw IPs are not persisted by the application. Provider attempt admission is conservative: reserved attempts may count against the budget even if a later limit stops the dispatch. It is an application request cap, not an exact dollar-spend guarantee.

## Staging smoke test before opening public ranked play

Use your actual API key and a non-production Discord server. Check a live JEV game on each profile and both starting sides, returned model/version, correct request/response parsing, all fallback conditions, signed command launch, wrong-account redemption rejection, OAuth logout/re-login, genuine scoped ranking attribution, interrupted requests, and all-match exports.

Run a bounded live benchmark before advertising any difficulty's strength. Keep pinned-model cohorts separate after upgrades. Re-run `scripts/build-manifest.js` after changing production source so official configurations obtain a new fingerprint.

The included tests exercise a D1-compatible interface backed by real local SQLite and mock external identity/model services. They do not establish the behavior of an actual deployed D1 account, Discord application configuration, provider credentials, or network edge. Those checks require staging.

## Operations and privacy

Operations reports are read-only and anonymous. Send the separate administrator credential in an Authorization header from an operator-controlled client; never put it in a URL or in browser storage. Example shell usage, with the token already stored in an environment variable:

```sh
curl -H "Authorization: Bearer $ADMIN_ANALYTICS_KEY" "https://YOUR_HOST/api/admin/operations"
```

Disable platform query-string/request-body capture, especially on OAuth callbacks and personal launch URLs. Application logs already omit those values; a hosting provider's independent request logs require their own configuration. The supplied Worker observability default is disabled to avoid unreviewed log capture.

Match evidence and results are retained until the operator removes them; they are not silently pruned and are not advertised as permanent storage. Establish a retention/export/deletion policy for your deployment and disclose it to players. Closed-match exports let users retain their own evidence. Deleting a stored match removes it from future leaderboard aggregation.
