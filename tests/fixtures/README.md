# Test fixtures

`pre-rename-export.json` is one completed match exported by the code at `main` commit `c634d30`, before the Tic-Tac-Toe → Tic-Tac-Typed rename. It was produced the way `tests/make-export-fixture.js` produces a match, with `TYPESAFE_API_KEY` set so the in-process fixture provider answers as live Jev (`decision.source: "jev"`). No real provider call was made.

It carries `config.gameId: "tic-tac-toe"`. `tests/rename.test.js` checks that it still passes `verifyMatch`, the same check `npm run verify-export` runs. Do not regenerate it with current code; it must stay a pre-rename record.
