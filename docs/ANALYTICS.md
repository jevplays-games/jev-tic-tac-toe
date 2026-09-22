# Analytics, evidence and measurement dictionary

## 1. Meaning of exhaustive

The reference audit is exhaustive over all **5,478 reachable boards**, including all **4,520 nonterminal boards**, all **16,167 legal transitions**, and all **255,168 terminal play sequences**. Deserialization is tested against all **19,683 raw assignments** using an independently generated bitboard reachability set.

The event log preserves every accepted placement and accepted computer decision in a stored match. It also preserves request preparation before external inference, configuration, recovery, completion and verification. Rejected HTTP requests are counted anonymously by normalized route/status/error, not retained with arbitrary attacker-controlled bodies. The service does not collect screen recordings, keyboard streams, chat text, IP addresses in match evidence, browser fingerprints, or hidden model reasoning.

The dashboard covers a labeled, bounded account/session window; the full export and offline benchmark are not restricted to that 500-match dashboard window. A planned live benchmark is not a completed exhaustive live evaluation. The ZIP's generated position baselines are explicitly **offline**.

## 2. Observation sources

| Source | Meaning | Counts as measured JEV inference? | Ranking consequence |
|---|---|---|---|
| `human` | Accepted human placement | No | Server-owned ranked match can remain eligible |
| `jev` | Valid, expected-version provider response selected the move | Yes | Eligible when all other checks pass |
| `forced` | Exactly one legal action; no external inference | No | Eligible |
| `fallback-minimax` | Deterministic server fallback following missing key, failure, budget exhaustion or abandoned request | No | Entire match becomes unranked |
| `local-minimax` | Browser-only practice after backend unavailability | No | Never official; not in server account aggregates |
| `baseline-minimax` | Offline exact baseline | No | Benchmark only |
| `baseline-tactical` | Offline win/block/positional heuristic | No | Benchmark only |
| `baseline-random` | Seeded random legal action | No | Benchmark only |

Never report fallback or exact-solver quality as JEV quality. `forced` observations are excluded from provider inference sample counts. A match played against a fallback may still contain earlier genuine JEV observations; analytics preserve both sources even though the game is no longer ranked.

## 3. Exact move quality

All values are from the perspective of the player placing the current mark. `+1` means a forced win under optimal continuation, `0` a draw, and `-1` a forced loss. These are categorical game-theoretic outcomes, not probabilities.

| Field / aggregate | Definition |
|---|---|
| `valueBefore` | Maximum attainable minimax value among legal actions |
| `valueAfter` | Exact value of the chosen candidate, for the same player |
| `regret` | `valueBefore - valueAfter`, in `{0,1,2}` |
| `optimal` / `optimalRate` | Chosen action belongs to the full optimal set; optimal decisions / observed decisions |
| `optimalCells` | Every equally optimal legal square, not only the tie-break favorite |
| `meanRegret` | Sum of regret / observed moves |
| `avoidableLosses` | Moves from a drawable/winnable board to a forced loss |
| `errorType` / `valueTransitions` | `win_to_draw`, `win_to_loss`, or `draw_to_loss` counts |
| `candidates` | Exact label for every legal alternative |
| `cellCounts` | Observed placements by cell, separated by source |
| `canonicalBoard` | Lexicographically smallest of eight board symmetries |

Exact annotations are generated **after selection**. `policy.js` does not import the exact evaluator. The complete response's selected action is validated against the legal set before application. Oracle annotations for human moves and raw traces are withheld from the browser until the match closes.

## 4. Tactical diagnostics

- `winOpportunity`: at least one immediate winning placement exists.
- `missedImmediateWin`: such a win existed and the chosen cell was not one of those wins. This is an immediate tactical omission; it need not lose ultimate game value.
- `necessaryBlockOpportunity`: the opponent has an immediate winning square, there is no immediate win for the current player, and at least one reply avoids the opponent's immediate win.
- `missedNecessaryBlock`: a block opportunity existed, but the chosen action leaves an immediate opponent win.
- `forkOpportunity` / `forkCells`: one or more legal candidates create two future winning squares without already terminating the game.
- `createsFork`: chosen action belongs to that fork set. Not selecting a fork is not automatically a minimax error.
- `factors`: factual descriptions such as an immediate winning line, occupation of an immediate opponent threat square, a fork, or a center placement.

Miss rates must use their opportunity denominators, not all turns. Multiple simultaneous opponent threats with no move that avoids an immediate loss do not count as an avoidable missed block. A minimax-perfect policy can still omit a delaying block in an already-forced-loss state; tactical omissions and game-theoretic regret are different measurements.

## 5. Provider decision evidence

Each provider-selected action stores:

```text
source, action, requested/returned model identifiers
exact allowlisted request (state, questions and criteria)
inputHash (SHA-256 of canonical request)
allowlisted response (answers and reported usage)
full per-question probability maps and confidence
chosen preference distribution
entropy and top-two margin
attempt records (index, startedAt, HTTP status, elapsed time, result)
end-to-end adapter latency and serialized input bytes
fallback reason when applicable
operator-priced token-cost estimate when configured
```

Authorization headers, credentials, cookies, OAuth tokens, user identity and Discord channel names are not in the model request or trace. Arbitrary extra provider fields are discarded. Probability keys must exactly match the options; finite values must be in `[0,1]`, their sum within `0.001` of one, and the documented choice must be a maximum-probability option. Returned model identity must match the pinned version.

The JEV profile uses model-provided candidate probabilities to calculate `P(win) - P(loss)`, rounds comparisons to six decimal places, then uses preference probability and a fixed center/corners/edges order for ties. It never consults minimax when selecting an ordinary JEV move.

## 6. Probability diagnostics

| Metric | Definition and caveat |
|---|---|
| `reportedConfidence` | Provider's own confidence values; descriptive only |
| `entropyBits` | `-Σ p log2(p)` after normalizing the distribution |
| `normalizedEntropy` | Entropy / `log2(number of options)`; zero for one option |
| `topMargin` | Largest minus second-largest reported preference probability |
| `optimalPreferenceMass` | Total normalized preference probability assigned to the exact optimal action set |
| `preferenceExpectedOracleValue` | Sum over legal candidates of preference probability × exact candidate value |

Preference confidence is not calibrated against game outcomes by assumption. A low-confidence decision can be good when many moves are equally optimal. The JEV profile's selected action may differ from the most likely move-preference option because its outcome questions are combined separately.

## 7. Outcome calibration

Only actual JEV-profile candidate `win/draw/loss` predictions produce these measurements. The label is the exact outcome after committing the candidate and assuming both sides continue optimally—not the observed result against a possibly imperfect human.

`multiclassBrier = mean(Σ_k (p_k - 1[k = label])²)`.

`nll = mean(-ln(max(1e-15, p_label)))`.

Classification accuracy chooses the highest-probability category; a deterministic stable option order resolves a tie. ECE uses ten equal-width bins of the winning category's probability, summing bin-size-weighted absolute differences between mean predicted confidence and empirical accuracy.

Empty sets return `null`, not zero error. Repeated candidates from the same board or game are dependent observations. A high sample count is not the same as an equally large number of independent games. No asymptotic confidence intervals or significance claims are fabricated. Use game/canonical-board grouped resampling for a research publication.

## 8. Timing, volume and cost

`latencyMs` measures adapter wall time using a monotonic timer. Each `attempt.latencyMs` measures request/response processing for that attempt, not isolated model GPU compute. `serverDwellMs` is elapsed wall time from the previous accepted state to the human request; it includes network time and time away from the game. Never call it pure human thinking time.

Summaries expose observation count, minimum, maximum, mean, p50, p95 and p99. Quantiles use linear interpolation at `(n-1)*p`. Missing or nonfinite observations are excluded; observed zero latency is valid. Fallback and model latency must be compared by source, not averaged into an unlabeled model number.

`inputTokens` and `outputTokens` sum **known successful-response usage**, not all billed activity. `usageKnown`, `jevCalls` and `unknownAttemptUsage` expose coverage. A timed-out or failed request could have consumed provider resources without returning usage. `inputBytes` is serialized JSON length, not a tokenizer estimate.

`knownEstimatedCostUsd` exists only when the operator supplies both token prices and a response supplies usage. It is not a provider invoice, does not include unknown-attempt billing, and excludes hosting/database fees. With no prices the aggregate is `null` and the UI says not configured. No changing provider prices are hard-coded.

## 9. Cohorts, player results and coverage

Leaderboard eligibility and ranking are separate from descriptive analytics.

The official cohort is the configuration hash plus human mark. The hash includes model version, difficulty, rules version, policy version, analytics version, source revision, fallback policy and decision budget. Channel/server context is captured at match start, never accepted from editable request IDs.

The descriptive account summary includes W/D/L, games, result rate `(wins + 0.5*draws)/games`, win rate, current/best chronological win streak, forfeits, void matches, and ranked-eligible matches. Mixed-profile totals are descriptive, not an overall rating. `bySource`, `byPly`, `byConfig` and `byCohort` provide drilldown. The UI's cohorts separate human mark; profile and mark filters also affect dashboard results.

The dashboard fetches the newest 500 closed matches, then applies its filters. Coverage explicitly reports this order and whether the window was truncated. This is a performance guard, not a claim of all-time completeness. History uses `(created_at,id)` pagination; the all-match export follows it to completion and does not silently output a partial file after an error.

## 10. Causal events and verification

Each event contains `schemaVersion`, `matchId`, monotonic per-match `seq`, UTC `at`, event `type`, `causedBy`, `payload`, `previousHash`, and `hash`. Sequence—not UTC wall time—establishes event order. Cross-request wall clocks do not claim a globally monotonic absolute time.

The chain is committed in the same match document as the authoritative transition through a conditional revision update. Before a JEV request, the backend persists the prepared state, questions, request hash and short-lived lease. It records accepted results before accepting the computer move. Crash recovery never silently re-samples the opponent; it marks the match unranked and uses a labeled fallback.

Offline verification checks the chain, manifest binding, all move actors and legality, regenerated exact annotations, duplicate decision evidence versus its event, reconstructed JEV requests, response schema, selection policy, actions versus application events, terminal outcome and completion event. It does not contact any external service.

**Limit:** hash links only detect changes relative to a trusted copy/head. They are not a cryptographic attestation that the provider really ran. The server-controlled records are the official authority; arbitrary uploaded exports never create leaderboard results.

## 11. Anonymous operational metrics

The backend maintains daily counters by normalized route, method, HTTP status, error code and latency bucket. They include count, sum and maximum duration, and contain no raw IP, user ID, request body or query string. Duration excludes the counter's own database write. Buckets are `[0,10)`, `[10,50)`, `[50,100)`, `[100,500)`, `[500,1000)`, `[1000,3000)` and `[3000,∞)` milliseconds.

`GET /api/admin/operations?day=YYYY-MM-DD` requires a separate `ADMIN_ANALYTICS_KEY` bearer credential and is absent when that key is not configured. It is intentionally not embedded in the public browser UI. Counters older than 30 days are pruned by maintenance. Logging failure is reported without secrets; it does not turn a legal game transition into a fabricated successful telemetry write.

## 12. Files and independent experiments

- `reports/reference-audit.json`: exhaustive counts and corpus SHA-256.
- `reports/reference-states.ndjson`: every reachable board, symmetry key, legal candidate values and optimal set.
- `reports/reference-edges.csv`: every legal state transition, with numerical minimax labels.
- `bench-runs/<run>/manifest.json`: frozen experiment specification, source/harness hashes and run ID.
- `results.ndjson`: hash-linked completed sample records, with full decisions and annotations.
- `request-ledger.ndjson`: fsynced pre-dispatch provider attempt records, sample ID and input hash; separate from result-chain records.
- `summary.json`: source-separated quality, by-ply/partition results, replication disagreement, token/latency/calibration summaries, coverage and explicit stop reason.
- Browser match JSON: full completed-match replay, decisions and event chain.
- Browser moves CSV: flat decision rows; text cells that could become spreadsheet formulas are escaped while negative numeric oracle values remain numeric.

Seeded source baselines, paired starting marks, symmetry-grouped splits and configuration pinning make comparisons reproducible. Whole-game metrics also report games containing any fallback. Frozen-policy adversarial evaluation requires coverage of every policy state it reaches and refuses fallback-contaminated JEV policies.
