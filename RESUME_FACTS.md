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
- **CI on every push:** typecheck, lint, tests with coverage, build, and a Playwright browser
  test on desktop and phone sizes. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Correctness (tested)

| Fact | Proof |
|---|---|
| The TypeScript engine replays all 272 hands recorded from the original game with identical hand histories and chip counts (12 sessions; 35 with side pots, 104 all-ins) | [test/golden.test.ts](test/golden.test.ts), [METRICS.md](METRICS.md#tests-and-coverage-typescript-port) |
| 43 tests in 5 files, all passing; about 89% statement coverage of the engine, bots and simulator (88.65% on 2026-10-31) | [tools/measure/results/2026-10-31-tests.txt](tools/measure/results/2026-10-31-tests.txt) |
| The 5-card evaluator ranks all 2,598,960 hands into the standard categories, with exactly 7,462 distinct values | [test/evaluator.test.ts](test/evaluator.test.ts) |
| All 22,100 three-card (3 Patti) hands match the standard category counts | [test/evaluator.test.ts](test/evaluator.test.ts) |
| AA vs KK (no shared suits): 81.255% equity, by exact enumeration of all 1,712,304 boards | [test/evaluator.test.ts](test/evaluator.test.ts), [METRICS.md](METRICS.md#tests-and-coverage-typescript-port) |
| Two rule bugs from the original fixed, each with a test that fails before and passes after: engine-side minimum raise, and cumulative short all-ins re-opening the betting | commits `3fa51fd`, `f1b239c`; [test/rules.test.ts](test/rules.test.ts) |
| Property tests: 300 random hands with random, often illegal actions conserve every chip; 500 random contribution layouts build correct side pots | [test/properties.test.ts](test/properties.test.ts) |
| Ported bots match the original's per-persona VPIP, PFR and aggression frequency within 3 standard errors, for all 16 persona/game rows (about 3,400 hands each side) | [METRICS.md](METRICS.md#bot-parity-typescript-bots-vs-the-original), [tools/measure/results/2026-10-31-bot-parity.txt](tools/measure/results/2026-10-31-bot-parity.txt) |
| Grading a decision later from snapshots (in the worker) gives exactly the grade computed at the time: 98 decisions across all five games | [test/coach-lazy.test.ts](test/coach-lazy.test.ts) |

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
- No multiplayer yet.
- No real-device phone measurements.
