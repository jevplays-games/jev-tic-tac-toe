# Verified release results

Production source fingerprint: `31b6df11c106ed54093b7424fcbe3f4dec54636b21c930809471a0873f3970c3`.

## Executed checks

| Check | Result |
|---|---|
| Node unit/integration suite | 68 passed; 0 failed; 0 skipped |
| JavaScript parser checks | 31 files passed |
| Chromium rendering/interaction checks | 12 passed; no uncaught JavaScript exceptions |
| Export replay / hash-chain verification | Single-match and all-match browser downloads passed |

Browser checks use in-memory application assets and a bridge to the actual native HTTP/SQLite API. Managed browser policy blocks navigation in this environment. **Normal browser navigation, cookie isolation and browser-enforced CSP/origin behavior were not exercised by that bridge.** The ordinary navigation test path remains included for staging.

## Exhaustive rules evidence

| Quantity | Result |
|---|---|
| Raw cell assignments | 19,683 |
| Reachable boards | 5,478 |
| Nonterminal boards | 4,520 |
| Legal state-transition edges | 16,167 |
| Rotation/reflection equivalence classes | 765 |
| Complete legal move sequences | 255,168 |

The test suite separately implements bitboard win detection and minimax, checking every reachable board and every legal edge against the application evaluator. The terminal game-tree traversal stops immediately after a win or draw.

## Offline reference baselines — not JEV

Each reference policy was evaluated once at every one of the 4,520 nonterminal boards, without contacting the model service. These are uniformly weighted board observations, not estimates of player encounter frequency.

| Policy | Optimal moves | Optimal-action agreement | Mean regret | Avoidable-loss decisions |
|---|---:|---:|---:|---:|
| minimax | 4,520 / 4,520 | 100.0000% | 0.000000 | 0 |
| tactical | 4,305 / 4,520 | 95.2434% | 0.049336 | 56 |
| random | 2,617 / 4,520 | 57.8982% | 0.648009 | 1,539 |

The random policy uses seed `20260922`; this is one seeded action per board, not the exact expected random-policy distribution. Minimax optimizes eventual outcome, not time to win. It can decline an immediate win while preserving a forced win, or decline a delaying block in an already-lost position. Tactical omission counts must not be confused with minimax regret.

In 200 seeded games against a random opponent, alternating the reference minimax policy's mark, the minimax policy recorded **177 wins, 23 draws, 0 losses**. A separate exact adversarial evaluation of its frozen policy produced value 0 (draw) from the empty board as both X and O.

Full manifests, hash-linked raw records, summaries, per-ply partitions and state/edge corpora are in `reports/`. The reference datasets are reproducible using the checked-in scripts.

## Not verified with external services

Actual TypeSafe inference and quality, actual Discord account authentication / guild command installation, and a deployed Cloudflare Worker / D1 account were not exercised. No actual API keys or deployment account were provided. Adapter/authentication tests use controlled responses and real local SQLite.

Do not advertise an unmeasured difficulty ordering, calibrated model win probability, production anti-cheat guarantee or provider latency on the basis of this release. Run the documented staging checks with your own credentials.
