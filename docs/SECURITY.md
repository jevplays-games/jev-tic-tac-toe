# Security boundaries and limitations

## Trust model

The browser, URL parameters, local storage, imported/downloaded replays and display names are untrusted. The server controls match participants, actions, model configuration, decision sources, context attribution, result eligibility and SQL ranking inputs. The remote provider is also untrusted until its structured response passes explicit validation.

Secrets are server environment values only. Model requests contain board state and fixed questions, not OAuth identity or arbitrary player text. No general inference proxy is exposed.

## Implemented defenses

- Opaque, random application session tokens; only their SHA-256 hashes are persisted. HttpOnly, SameSite=Lax, Secure and `__Host-` protections in production; isolated loopback-development cookie exception.
- Seven-day absolute session life and one-day idle life. Session rotation after successful OAuth; one-use five-minute state bound to the initiating browser session.
- Exact origin plus synchronizer-CSRF token for every browser mutation. State-changing match resumption is POST, not GET.
- Discord Ed25519 signature verification over the timestamp and exact raw bytes; five-minute freshness bound; guild/application checks; duplicate interaction IDs; personal one-use launch redemption.
- Revision compare-and-swap updates; one active match per session or account, admitted atomically (conditional insert), and one active ranked match per account by unique index; idempotency receipts; request preparation and decision leases; stale model responses cannot move the board twice.
- Rules-based replay and expected-version response verification; no trusted client score endpoint.
- Restrictive CSP, no external client libraries or tracking calls, `textContent` for untrusted text, no arbitrary HTML rendering, no reflected request bodies in errors, no credential-bearing application logs.
- Strict input/action/response sets, JSON byte limits, rate limits before costly work, request-attempt budgets, fixed provider endpoint and finite legal candidates.
- Spreadsheet-formula defenses on text CSV cells; numeric negative oracle values remain ordinary numeric values.
- Private account/session evidence; community views require a fresh verified grant; operations reporting uses a separate read-only secret.

## What is not established

1. An exact solver's analytics do not establish JEV quality. Live inference must be measured separately. Model version pinning does not prove deterministic remote inference.
2. A valid export hash chain is not a provider signature and does not prevent a party from rewriting every link. Original server data or a separately retained trusted head is required for authenticity comparisons.
3. Server ownership prevents trivial score/AI forgery, not human use of an external solver, bots controlling a browser, multiple accounts, or collusion. No monetary competitions should rely on this prototype's anti-cheat model.
4. A launch grant proves launch-time guild/channel participation, not continuously checked membership. Short expiry limits but does not eliminate revocation lag.
5. The application does not audit a cloud provider's independent access logs, permission settings, quotas, custom-domain configuration or backup arrangements. Review these before production.
6. Rate limits are resource guards, not invoice reconciliation. A failed/aborted provider call may still incur charges without a usage response. Metrics explicitly track unknown attempt usage.
7. Native Node is a loopback development server, not an internet-hardened reverse proxy. Production cookies and hosting assume HTTPS.
8. The implementation has automated tests, not a third-party security audit or a claim of formal correctness of the entire networked service.

## Data management

Application identity storage contains only the public player ID, Discord ID, display name, avatar reference, moderation state and timestamps. OAuth access/refresh tokens are not retained. Match events have no raw user emails or Discord message content. Exports can contain guild/channel IDs; users should review them before sharing.

Matches are retained until operator removal. Establish a published retention/deletion process appropriate to the deployment before inviting users. Back up the database and preserve original audit artifacts securely. Removing an account's match rows removes them from future rankings; do not mutate historical result values to fulfill deletion requests.
