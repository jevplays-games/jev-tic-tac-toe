# Verification and test coverage

## Automated code tests

Run `npm test`. The suite uses Node's native test runner and actual local SQLite behind the same D1-shaped methods used by the Worker. TypeSafe and Discord responses are deliberately mocked for contract/integration tests; mocks are never offered to users as genuine JEV play.

Covered paths include:

- all 19,683 raw-board reachability classifications against an independent bitboard set;
- all 5,478 reachable board values and 16,167 legal candidate values against independent bitboard minimax;
- terminal boundaries, draws, illegal actions, serialization and replay;
- all four profile encodings on all nonterminal boards, legal candidate completeness and absence of oracle/identity inputs;
- response shapes, probability validity, model mismatch, typed question IDs, deterministic full-profile ties;
- forced actions, no-key fallback, invalid JSON/schema, transient retry, Retry-After and abort timeout;
- session, origin/CSRF, OAuth state consumption/rotation, privacy of credentials and Ed25519 interactions;
- rank requirements, source labeling, ownership isolation, forged score/context rejection;
- idempotent requests, concurrent actions, stale revisions, prepared-before-dispatch evidence, expiry, resignation and abandoned-lease recovery;
- full verification of action and duplicated decision evidence, hash-chain tampering;
- profile/mark/channel/server isolation, twenty-game ranking thresholds, tied ranks and stable pagination;
- metrics null behavior, opportunity denominators, exact calibration examples, CSV safety and negative labels;
- benchmark repeatability, offline labeling, manifest-safe resume, mixed-treatment rejection and explicit live-call consent.
- initial-match recovery on page load (`tests/boot.test.js`): a live match is restored and never duplicated across reloads or a second session on the same account, expired matches are resumed before being replaced, an absent, foreign or invalid prior id yields one new match, load/resume/create failures never create or replace a match and retry idempotently with the same `requestId`, and two tabs serialised by the boot lock create one match. `tests/admission.test.js` races real `handle()` requests against SQLite: distinct-key and same-key creates from one session, several sessions of one account, ranked, a same-key body conflict, provider-driven openings (provider called once), resign/expiry/ownership, and a duplicate key reported by `insertMatch`; the same file fails against the previous check-then-insert. `tests/browser-boot.py` additionally overlaps four real tabs (with and without Web Locks) and observes the loader, error and Retry on screen.

Actual packaged totals and logs are in `reports/verification.json` and `reports/test-output.txt`.

## Browser checks

The optional browser suite is:

```sh
python -m pip install -r tests/requirements.txt
python -m playwright install chromium
npm start
# Separate terminal:
python tests/browser-smoke.py
```

Set `CHROMIUM_PATH` when using a separately installed Chromium executable. The browser suite checks game controls, keyboard navigation, rules dialog, full-game completion, accurate fallback labeling, replay reconstruction, export downloads, analytics, private history, evidence toggling, mobile overflow and uncaught JavaScript exceptions.

### Packaging environment limitation

This container's managed Chromium blocks all URL navigation. Its policy was not changed. The recorded packaging run therefore uses `EMBEDDED_BROWSER=1`: the known application HTML/CSS/modules are supplied in memory, while an explicit test bridge forwards API requests to the actual local Node/SQLite server. This exercises rendering, actual application JavaScript, backend integration and exports, **but not normal browser navigation, same-origin transport behavior, browser cookie isolation or production CSP enforcement**.

Those normal-navigation assertions remain in `tests/browser-smoke.py` for an unrestricted development/staging browser. Do not present the embedded run as an end-to-end production browser security test. Screenshots contain real no-key fallback sessions and do not fabricate JEV outputs.

## Reference and baseline artifacts

`npm run audit` regenerates every reachable state and edge plus the complete-game counts. `reports/reference-audit.json` includes a corpus hash.

The package's offline benchmark directories contain full position-level baseline outputs, frozen experiment manifests and source-separated summaries. They establish evaluator/baseline behavior, not JEV strength. The live harness is opt-in, requires credentials, is capped, retains request/response evidence and will not silently resume an uncommitted live request.

## External checks not performed here

No real TypeSafe inference, live Discord authorization/command installation, or Cloudflare deployment is asserted. Use your staged application and credentials to exercise those paths. No Apple/Safari or Firefox browser run, screen-reader user study, load test, penetration test or independent third-party audit was completed during packaging.

`npm run verify-export` needs an export file: `node tests/make-export-fixture.js /tmp/export.json` writes a completed fixture match (no real provider) and `npm run verify-export -- /tmp/export.json` verifies it.
