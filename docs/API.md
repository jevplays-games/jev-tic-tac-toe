# HTTP API

All application API responses use JSON except redirects and Discord interaction responses. Errors are `{error, requestId, detail?}`. Requests are same-origin; CORS is not enabled.

For browser mutations: session cookie, exact `Origin`, and `X-CSRF-Token` from `/api/me` are required. JSON bodies must have `Content-Type: application/json` and are bounded to 4 KiB. Discord's signed endpoint instead accepts the exact signed body, bounded to 64 KiB.

| Method and path | Purpose |
|---|---|
| `GET /api/me` | Establish guest session if needed; get identity, CSRF, active match, contexts and current configurations |
| `GET /api/auth/discord?launch=...` | Store optional pending launch hash and start OAuth; never consumes launch on GET |
| `GET /api/auth/discord/callback` | Consume OAuth state, exchange code, rotate session, redirect to `/` |
| `POST /api/logout` | Revoke current session |
| `POST /api/discord/interactions` | Ed25519-verified Discord ping or guild `/play tic-tac-toe` |
| `POST /api/context/redeem` | Redeem the authenticated session's pending user-bound launch |
| `POST /api/matches` | Start an authoritative match |
| `GET /api/matches/:id` | Read own authoritative match; no inference triggered by GET |
| `POST /api/matches/:id/actions` | Place or resign with revision and idempotency key |
| `POST /api/matches/:id/resume` | Resume a pending/expired own match; CSRF protected |
| `GET /api/history` | Own account/session matches, up to 100 per page |
| `GET /api/analytics` | Summary of latest 500 closed own matches, with explicit coverage |
| `GET /api/leaderboard` | Public world results or context-authorized guild/channel results |
| `GET /api/admin/operations` | Optional anonymous operational counters, protected by separate bearer secret |

## Creation

```json
{
  "requestId": "client-generated-unique-id-at-least-16-chars",
  "humanMark": "X",
  "difficulty": "normal",
  "ranked": false
}
```

Supported profiles: `easy`, `normal`, `hard`, `jev`. No client model, score, winner, guild or channel field is authoritative. The server captures configured model/version and valid context itself.

Same creation key and normalized options returns the existing match. A conflicting body produces `409`. A new attempt while another owned match is active returns `409 active_match_exists` with `detail.matchId`. Status is `201` on creation, or `202` when service work remains pending.

## Placement / resignation

```json
{
  "requestId": "a-new-id-for-this-logical-action",
  "expectedRevision": 3,
  "action": {"type": "place", "cell": 2}
}
```

Resignation: `action: {"type":"resign"}`. Reuse the identical request ID/body after an uncertain network failure. A duplicate returns the current authoritative match without appending another placement or making another provider call. Changing the body while retaining the same ID returns `409 idempotency_conflict`.

The response is a public match view with revision, status, board, configuration, human mark, timing, eligibility and source-labeled actions. During active play, exact oracle labels and raw provider evidence are withheld. Closed matches include their full actions, events and audit result. No session hashes, OAuth tokens or provider credentials are exported.

## History and analytics

History parameters: `limit` (default 50, max 100), `beforeTime`, `beforeId`. Use the returned `next` object unchanged to continue. The last page returns `next:null`. History only includes matches the session owns; authenticated ownership spans sessions via the public account identifier.

Analytics parameters: optional `difficulty`, `mark` (`X`/`O`), or exact `config` hash. The result includes `summary`, `coverage`, and `asOf`. Filters are applied after selecting the latest 500 closed matches, and that fact is returned in coverage metadata.

## Leaderboards

Parameters: `scope=world|server|channel`, `difficulty`, `mark=X|O`, optional archived `config` hash, `limit` (default 50, max 100), and the returned `offset`/`asOf` cursor fields.

A channel/server query derives the ID solely from the authenticated session's still-valid launch grant. Editable `guild`, `channel`, or similarly named query fields are ignored and cannot switch the verified scope. Snapshot cutoff `asOf` prevents newly completed games from changing result counts while paging. Moderation changes can still change display availability.

Each entry contains a public player ID, display name, rank/null, provisional flag, games, W/D/L, forfeits and result rate. Raw Discord IDs and other players' game evidence are not public world leaderboard fields.

## Operational report

`Authorization: Bearer <ADMIN_ANALYTICS_KEY>` is required. No browser login substitutes for this credential. An optional `day=YYYY-MM-DD` selects the UTC day. Results contain only daily aggregate counters and timing buckets, with no identity or gameplay content.
