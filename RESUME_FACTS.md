# River Room: verified facts

Every line below is something that exists and was measured or tested, with a link to the
proof. Nothing here is an estimate. Dates are when the measurement was taken.

## What exists

- **Live app.** https://sumer-riverroom.vercel.app, deployed from this repository on Vercel.
  A smoke test runs against it after every production deploy:
  [.github/workflows/live-smoke.yml](.github/workflows/live-smoke.yml).
- **Engine.** A TypeScript poker engine, 1,501 lines in [src/engine](src/engine) (`wc -l src/engine/*.ts`, 2026-10-31).
  It covers Hold'em plus four split variants (2-of-3 majority pots), side pots, odd chips,
  antes, and the TDA short-all-in rule.
- **Coach.** In strict TypeScript, DOM-free: [src/coach](src/coach).
- **Bots and the coach run in a Web Worker:** [src/worker](src/worker),
  [src/coach/compute.ts](src/coach/compute.ts).
- **AI hand review.** A Vercel serverless route ([api/review.ts](api/review.ts)) streams a
  review from Claude Haiku 5.5. The output is validated with zod (grade, mistake, lesson).
  Rate limits are per IP (5 a minute, 20 an hour) plus 300 an hour per instance. Without a
  key, or when limited, the page falls back to the built-in review. There is a 20-hand eval
  set with a scoring script ([tools/review](tools/review)).
- **Multiplayer server.** Node + TypeScript + Socket.IO in [server/](server), running the same
  engine. It is server-authoritative: the server shuffles, and each client receives only its
  own cards. Invite-code rooms, reconnect by session token, bots in empty seats, a turn
  timer, zod-validated messages and a per-socket rate limit.
- **Storage and settle-up.** Postgres via Prisma ([prisma/schema.prisma](prisma/schema.prisma)):
  rooms, players (token hashes only), hand histories and a buy-in/rebuy/cash-out ledger.
  "Settle up" computes the fewest payments ([src/ledger/settle.ts](src/ledger/settle.ts)).
- **CI on every push:** typecheck, lint, tests with coverage (with a Postgres service
  container), build, a Playwright browser test on desktop and phone sizes, and a two-browser
  multiplayer test. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Correctness (tested)

| Fact | Proof |
|---|---|
| The TypeScript engine replays all 272 hands recorded from the original game with identical hand histories and chip counts (12 sessions; 35 with side pots, 104 all-ins) | [test/golden.test.ts](test/golden.test.ts), [METRICS.md](METRICS.md#tests-and-coverage-typescript-port) |
| 72 tests in 10 files, all passing, including the Postgres storage test | [tools/measure/results/2026-10-31-tests-with-postgres.txt](tools/measure/results/2026-10-31-tests-with-postgres.txt), [METRICS.md](METRICS.md#tests-with-postgres-current-suite) |
| About 89% statement coverage of the engine, bots and simulator (88.65% on 2026-10-31) | [tools/measure/results/2026-10-31-tests.txt](tools/measure/results/2026-10-31-tests.txt) |
| The 5-card evaluator ranks all 2,598,960 hands into the standard categories, with exactly 7,462 distinct values | [test/evaluator.test.ts](test/evaluator.test.ts) |
| All 22,100 three-card (3 Patti) hands match the standard category counts | [test/evaluator.test.ts](test/evaluator.test.ts) |
| AA vs KK (no shared suits): 81.255% equity, by exact enumeration of all 1,712,304 boards | [test/evaluator.test.ts](test/evaluator.test.ts), [METRICS.md](METRICS.md#tests-and-coverage-typescript-port) |
| Two rule bugs from the original fixed, each with a test that fails before and passes after: engine-side minimum raise, and cumulative short all-ins re-opening the betting | commits `3fa51fd`, `f1b239c`; [test/rules.test.ts](test/rules.test.ts) |
| Property tests: 300 random hands with random, often illegal actions conserve every chip; 500 random contribution layouts build correct side pots | [test/properties.test.ts](test/properties.test.ts) |
| Ported bots match the original's per-persona VPIP, PFR and aggression frequency within 3 standard errors, for all 16 persona/game rows (about 3,400 hands each side) | [METRICS.md](METRICS.md#bot-parity-typescript-bots-vs-the-original), [tools/measure/results/2026-10-31-bot-parity.txt](tools/measure/results/2026-10-31-bot-parity.txt) |
| Grading a decision later from snapshots (in the worker) gives exactly the grade computed at the time: 98 decisions across all five games | [test/coach-lazy.test.ts](test/coach-lazy.test.ts) |
| Multiplayer: no client ever received another player's hidden cards. 1,312–1,445 views checked per run over 12 hands, 5 runs, 0 leaks. Reintroducing a visibility bug makes the test fail 3 of 3 times | [test/server.test.ts](test/server.test.ts), [METRICS.md](METRICS.md#multiplayer-no-card-leak-check) |
| Multiplayer: a disconnected player gets the same seat and the same cards back by session token; a wrong token is refused | [test/server.test.ts](test/server.test.ts) |
| Storage: the settlement read from Postgres matches the in-memory ledger; a leaver's stored cash-out equals buy-ins plus stored hand results; tokens are stored only as SHA-256 hashes | [test/store.test.ts](test/store.test.ts), [METRICS.md](METRICS.md#tests-with-postgres-current-suite) |
| Settlement uses the fewest possible payments: equal to a brute-force minimum on 400 random cases; exact for up to 16 people in 10.65 ms mean (20.7 ms worst) | [test/settle.test.ts](test/settle.test.ts), [METRICS.md](METRICS.md#settlement-fewest-payments) |
| AI review scoring pipeline: a perfect mock scores 100%, an "always fine" mock 57.1%, on the 20-hand eval set | [METRICS.md](METRICS.md#ai-hand-review-eval) |

## Performance (measured, Chromium 141, cloud VM, 2026-10-31)

| Fact | Proof |
|---|---|
| Worst main-thread freeze during play: 719 ms before, 99 ms after the Web Worker change (1x CPU, 60 s per game, all five games) | [METRICS.md](METRICS.md#freeze-fix-before-and-after-web-worker--coach-on-demand) |
| With 4x CPU slowdown (emulated): worst freeze 3.5 s before, under 200 ms after | [METRICS.md](METRICS.md#freeze-fix-before-and-after-web-worker--coach-on-demand) |
| Found and fixed a regression introduced in the port: drawing every random number from crypto was about 160x slower than a seeded PRNG (0.3 M vs 49 M draws/s, rough microbenchmark) | commit `2e6dad5`, [METRICS.md](METRICS.md#a-regression-found-and-fixed-on-the-way) |
| Hand evaluator throughput: 2.15–2.29 M five-card hands/s and 1.62–1.94 M seven-card hands/s in Node | [tools/measure/results/2026-10-31-eval-bench.txt](tools/measure/results/2026-10-31-eval-bench.txt) |
| Simulator: from 7.2 ms per hand (tournament Hold'em) to 690 ms per hand (8-card split game) | [tools/measure/results/2026-10-31-simulator.txt](tools/measure/results/2026-10-31-simulator.txt) |

## Not claimed

- No user numbers yet.
- No Lighthouse score yet.
- No real-model score for the AI review yet (waiting for the API key in Vercel).
- Multiplayer and storage are built and tested, but not yet deployed (waiting for the Railway
  service).
- No real-device phone measurements.
