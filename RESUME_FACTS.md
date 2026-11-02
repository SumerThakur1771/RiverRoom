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
- **Screen code type-checked.** The UI, 1,576 lines in [src/ui/legacy.js](src/ui/legacy.js) (`wc -l`, 2026-10-31), is
  checked by TypeScript (checkJs, non-strict) in CI: 94 errors at first, now 0. The worker
  client is strict TypeScript with per-job result types. Not claimed: a strict TypeScript UI.
- **Bots and the coach run in a Web Worker:** [src/worker](src/worker),
  [src/coach/compute.ts](src/coach/compute.ts).
- **AI hand review.** A Vercel serverless route ([api/review.ts](api/review.ts)) calls
  OpenRouter with plain fetch. Two free models from different providers go first, then a
  paid one as a last resort, capped at 200 paid calls a day. Answers stream back and are
  validated with zod (grade, mistake, lesson).
  - Reviews are cached by a hash of the prompt in the browser and on the server.
  - The prompt is 41% shorter: 2,833 to 1,683 characters per hand on average, on the 20-hand
    eval set ([proof](tools/measure/results/2026-11-01-review-prompt-size.txt)).
  - Without a key, or past the limits, the page falls back to the built-in review.
  - There is a 20-hand eval set with a scoring script ([tools/review](tools/review)).
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
| 88.88% statement coverage (82.27% branches) of all code outside the page: engine, bots, simulator, coach, AI review, ledger and multiplayer server | [tools/measure/results/2026-10-31-coverage-current.txt](tools/measure/results/2026-10-31-coverage-current.txt), [METRICS.md](METRICS.md#tests-with-postgres-current-suite) |
| The 5-card evaluator ranks all 2,598,960 hands into the standard categories, with exactly 7,462 distinct values | [test/evaluator.test.ts](test/evaluator.test.ts) |
| All 22,100 three-card (3 Patti) hands match the standard category counts | [test/evaluator.test.ts](test/evaluator.test.ts) |
| AA vs KK (no shared suits): 81.255% equity, by exact enumeration of all 1,712,304 boards | [test/evaluator.test.ts](test/evaluator.test.ts), [METRICS.md](METRICS.md#tests-and-coverage-typescript-port) |
| Two rule bugs from the original fixed, each with a test that fails before and passes after: engine-side minimum raise, and cumulative short all-ins re-opening the betting | commits `3fa51fd`, `f1b239c`; [test/rules.test.ts](test/rules.test.ts) |
| Property tests: 300 random hands with random, often illegal actions conserve every chip; 500 random contribution layouts build correct side pots | [test/properties.test.ts](test/properties.test.ts) |
| Ported bots match the original's per-persona VPIP, PFR and aggression frequency within 3 standard errors, for all 16 persona/game rows (about 3,400 hands each side) | [METRICS.md](METRICS.md#bot-parity-typescript-bots-vs-the-original), [tools/measure/results/2026-10-31-bot-parity.txt](tools/measure/results/2026-10-31-bot-parity.txt) |
| Grading a decision later from snapshots (in the worker) gives exactly the grade computed at the time: 98 decisions across all five games | [test/coach-lazy.test.ts](test/coach-lazy.test.ts) |
| Online play is anti-cheat by construction: the server sends each person a whitelisted copy of the game. Over every game type with three people at one table, 3,724 copies checked with 0 leaks; on a live server, about 5,000 messages a run (3 runs) with 0 leaks, while people chose games and split their own cards. A deliberately broken rule makes the tests fail | [src/net/wire.ts](src/net/wire.ts), [test/wire.test.ts](test/wire.test.ts), [METRICS.md](METRICS.md#online-play-no-card-leak-checks) |
| Online play uses the single-player table screen itself: the page replays the server's engine steps through the same handlers and animations, and answers only what the server asks that person | [DESIGN.md](DESIGN.md#10-online-play-the-same-table-dealt-by-the-server-server-srcnetwirets), [tools/ui/online-ui.mjs](tools/ui/online-ui.mjs) |
| Character roster: play as Sumer or any friend, rename, add (up to six) and remove (down to two); picked characters lock online; the computer plays the rest in their styles. Every game type plays at every table size from 2 to 6 with chips conserved; a game the deck cannot deal (8 cards to 6 players: 53 cards) falls back safely | [src/engine/roster.ts](src/engine/roster.ts), [test/roster.test.ts](test/roster.test.ts), [tools/ui/roster-ui.mjs](tools/ui/roster-ui.mjs) |
| The live deck shuffle is exactly uniform: Fisher-Yates with rejection sampling on crypto values (the old `% n` method was biased for 46 of 51 step sizes, by up to 1.2e-8). Verified exhaustively on an 8-bit source, by chi-square on 52,000 shuffles, and by a test that fails if the bias comes back | [test/shuffle.test.ts](test/shuffle.test.ts), [METRICS.md](METRICS.md#deck-shuffle-exact-uniformity-live-play) |
| Online play is live on free tiers (Vercel, Render, Neon). After every deploy, two real browsers on the live site, desktop and phone and then the reverse: start a table, join by invite link with a locked character, play dealer's choice, edit players, settle up from Neon (matching memory), reload, leave; 0 accessibility violations | [tools/measure/results/2026-11-02-online-live.txt](tools/measure/results/2026-11-02-online-live.txt), [METRICS.md](METRICS.md#online-play-on-production) |
| Multiplayer: a disconnected player gets the same seat and the same cards back by session token; a wrong token is refused | [test/server.test.ts](test/server.test.ts) |
| Online waiting room: the host opens a table, shares a 6-character code, sets the number of computer players (0 to 5) and the turn timer (off/15/30/60 s), and starts when everyone is in; friends join by typing the code or by link, as a free character or a new one with a fresh buy-in; per-tab seats, inline renames, host-only removal; a table that drops below two players goes back to waiting. Covered by 7 new server-room tests and a three-browser test (desktop and phone, both ways round), 2 runs in a row passing locally, then passing on production (Vercel + Render + Neon, both pairings); it found and fixed a "no timer" bug that would have folded for the player after 1 s | [METRICS.md](METRICS.md#online-waiting-room-local-before-deploy), [tools/measure/results/2026-11-02-waiting-room-live.txt](tools/measure/results/2026-11-02-waiting-room-live.txt) |
| Storage: the settlement read from Postgres matches the in-memory ledger; a leaver's stored cash-out equals buy-ins plus stored hand results; tokens are stored only as SHA-256 hashes | [test/store.test.ts](test/store.test.ts), [METRICS.md](METRICS.md#tests-with-postgres-current-suite) |
| Settlement uses the fewest possible payments: equal to a brute-force minimum on 400 random cases; exact for up to 16 people in 10.65 ms mean (20.7 ms worst) | [test/settle.test.ts](test/settle.test.ts), [METRICS.md](METRICS.md#settlement-fewest-payments) |
| AI review scoring pipeline: a perfect mock scores 100%, an "always fine" mock 57.1%, on the 20-hand eval set | [METRICS.md](METRICS.md#ai-hand-review-eval) |
| Live AI review eval (deployed endpoint, real models): 87.1% agreement with the app's coach on 20 hands, every hand answered by a free model (0 paid calls, 0 fallbacks), median response 5.1 s | [tools/measure/results/2026-11-01-review-eval-live-run2.txt](tools/measure/results/2026-11-01-review-eval-live-run2.txt), [METRICS.md](METRICS.md#live-openrouter-deployed-endpoint-2026-11-01) |
| Found with the live eval and fixed: one free model was cut off on all 20 hands (its thinking used the whole 500-token budget). A separate thinking budget took it from 0 to 20 valid answers, and the free share from 0/20 to 20/20 | [run 1](tools/measure/results/2026-11-01-review-eval-live-run1.txt), [run 2](tools/measure/results/2026-11-01-review-eval-live-run2.txt) |

## Installable and accessible (measured, 2026-10-31)

| Fact | Proof |
|---|---|
| Lighthouse accessibility 100 on both pages of the live site, 3 runs each (Lighthouse 13.5.0, mobile); also 100 locally. CI and the post-deploy check fail below 95 | [tools/measure/results/2026-10-31-lighthouse-live.txt](tools/measure/results/2026-10-31-lighthouse-live.txt), [METRICS.md](METRICS.md#lighthouse-live-site), [run 41171217087](https://github.com/SumerThakur1771/RiverRoom/actions/runs/41171217087) |
| Lighthouse accessibility 100 on the local production build (3 runs per page) | [METRICS.md](METRICS.md#lighthouse-local-production-build), [tools/measure/results/2026-10-31-lighthouse-local.txt](tools/measure/results/2026-10-31-lighthouse-local.txt) |
| 0 axe-core WCAG 2.1 A/AA violations on 6 in-game screens (table, hint, review × desktop, phone); found and fixed 1 that Lighthouse's start-screen audit could not see | [METRICS.md](METRICS.md#accessibility-of-in-game-screens-axe-core), [tools/ui/axe-table.mjs](tools/ui/axe-table.mjs) |
| Installable PWA with a hand-written service worker (no Workbox); single-player plays with the network cut (to hand #3 in 60 s in the test), checked in CI | [src/pwa/sw.js](src/pwa/sw.js), [METRICS.md](METRICS.md#offline-play-service-worker) |

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
- No cost figure for the AI review's paid calls (OpenRouter reports it in the function logs,
  which were not read here).
- No real-device phone measurements.
- No visitor numbers yet. Vercel Web Analytics is live and sends page views without query
  strings ([proof](tools/measure/results/2026-11-01-web-analytics-live.txt)).
