# Metrics

Every number in this repo comes from a command listed here. Raw outputs are saved in
[`tools/measure/results/`](tools/measure/results/). Anything not listed here has not been
measured, and the docs don't claim it.

## Environment

| | |
|---|---|
| Date | 2026-10-31 |
| Machine | Cloud sandbox: Intel Xeon @ 2.80 GHz, 4 vCPU, 15 GB RAM, Linux 6.18 |
| Node | v22.22.0 |
| Browser | Chromium 141.0.7390.37 (headless, via Playwright) |
| Code measured | `legacy/river-room.html` (artifact version 31), unchanged |

These are shared cloud machines. Expect run-to-run variation; ranges are given where a
command was run more than once.

## Size of the legacy build

| Metric | Value | Command |
|---|---|---|
| Lines | 3,914 | `wc -l legacy/river-room.html` |
| Bytes | 306,409 | `wc -c legacy/river-room.html` |
| Bytes gzipped (-9) | 93,101 | `gzip -9 -c legacy/river-room.html \| wc -c` |
| Top-level functions | 215 | `grep -c "^function \|^async function " legacy/river-room.html` |

## Hand evaluator (correctness + throughput)

Command: `node tools/measure/eval-bench.mjs`. Output:
[`results/2026-10-31-eval-bench.txt`](tools/measure/results/2026-10-31-eval-bench.txt).
The script extracts the real `evaluate` source from the legacy file.

| Metric | Value |
|---|---|
| 5-card hands enumerated | 2,598,960 (all of C(52,5)) |
| Category counts | All 9 match the standard frequencies (40 / 624 / 3,744 / 5,108 / 10,200 / 54,912 / 123,552 / 1,098,240 / 1,302,540) |
| Distinct hand values | 7,462 (matches the known number of 5-card classes) |
| 5-card throughput | 2.15 M – 2.29 M hands/s over 3 runs (1,134–1,208 ms for all 2,598,960) |
| 7-card throughput (1,000,000 seeded random hands, after warm-up) | 1.62 M – 1.94 M hands/s over 3 runs |

## 3 Patti scorer (correctness)

Command: `node tools/measure/teenpatti-check.mjs`. Output:
[`results/2026-10-31-teenpatti-check.txt`](tools/measure/results/2026-10-31-teenpatti-check.txt).

| Metric | Value |
|---|---|
| 3-card hands enumerated | 22,100 (all of C(52,3)) |
| Category counts | Trail 52, Pure sequence 48, Sequence 720, Color 1,096, Pair 3,744, High card 16,440: all match |
| Distinct scores | 741 (= 13 + 12 + 12 + 274 + 156 + 274) |
| Sequence order | A-K-Q > A-2-3 > K-Q-J: correct |

## Main-thread blocking in the browser

Command: `node tools/measure/longtasks.mjs 60 1` (60 s per variant, no CPU throttle) and
`node tools/measure/longtasks.mjs 60 4` (4× CPU slowdown via the DevTools protocol).

Method:
- The script builds an instrumented copy of the legacy file in a temp folder:
  - animation/think waits shortened (timers, not CPU work),
  - a hook to force the variant,
  - the hero's final split auto-picked,
  - timing wrappers around key functions.
- `oppDist` is timed only on cache misses. Wrapping its millions of cache hits inflated the
  callers' timings in an earlier run, so that run was discarded.
- The hero opens a hint on every decision, then calls.
- A `PerformanceObserver` records every `longtask` (>50 ms). Each long task is attributed to
  the largest timed call inside it.

Limits:
- Playwright's polling runs inside the page.
- This is an automated session, not a person.
- 4× throttling is an emulation, not a real phone.

### 1× CPU

Output: [`results/2026-10-31-longtasks-1x.txt`](tools/measure/results/2026-10-31-longtasks-1x.txt)

| Variant | Hands | Long tasks | Worst | `coachContext` median / p95 / max (ms) | Bot decision median / p95 / max (ms) | `oppDist` (cache miss) max |
|---|---|---|---|---|---|---|
| Hold'em | 18 | 5 | 645 ms | 2.4 / 7.6 / 19.4 | 0.7 / 3.4 / 5.7 | 645 ms |
| Poker + 3 Patti | 16 | 51 | 719 ms | 56.5 / 131 / 156.9 | 22.7 / 51.5 / 95.5 | 719 ms |
| Two boards | 14 | 34 | 675 ms | 43.7 / 85.7 / 119.7 | 18.3 / 31.9 / 65.7 | 676 ms |
| 8 cards | 11 | 128 | 627 ms | 295.9 / 479.2 / 539.6 | 64 / 109.4 / 138.3 | 61 ms* |
| 7 cards | 13 | 104 | 603 ms | 98.4 / 147.2 / 165.1 | 41.6 / 77.3 / 96.8 | 603 ms |

\* In the 8-card run, its own `oppDist('k8')` ran during the first deal, before recording
started. The three recorded misses are the other, cheaper variants.

### 4× CPU (emulated)

Output: [`results/2026-10-31-longtasks-4x.txt`](tools/measure/results/2026-10-31-longtasks-4x.txt).
Fewer hands fit in 60 s, so sample sizes are smaller.

| Variant | Hands | Long tasks | Worst | `coachContext` median / p95 / max (ms) | Bot decision median / p95 / max (ms) | `oppDist` (cache miss) max |
|---|---|---|---|---|---|---|
| Hold'em | 10 | 77 | 3,132 ms | 9.3 / 43.1 / 45.6 | 1 / 12.3 / 18.2 | 3,132 ms |
| Poker + 3 Patti | 7 | 132 | 2,480 ms | 342.3 / 463.6 / 796.8 | 107.6 / 204.1 / 292.1 | 2,479 ms |
| Two boards | 7 | 155 | 3,476 ms | 200.4 / 318.1 / 418.3 | 69.7 / 139.8 / 172 | 3,476 ms |
| 8 cards | 3 | 97 | 2,509 ms | 2,078.3 / 2,504.6 / 2,504.6 | 378.2 / 530 / 594.4 | 499 ms* |
| 7 cards | 6 | 127 | 3,022 ms | 353.6 / 667.4 / 699 | 136.3 / 297.6 / 374.6 | 3,022 ms |

\* Same note as above: `oppDist('k8')` ran before recording started.

## `oppDist` cost by variant (Node, no browser)

Command: [`tools/measure/oppdist-bench.mjs`](tools/measure/oppdist-bench.mjs). Output:
[`results/2026-10-31-oppdist-bench.txt`](tools/measure/results/2026-10-31-oppdist-bench.txt).

| Measurement | ms |
|---|---|
| `tpPct` first call (builds the 22,100-hand 3 Patti table) | 39 |
| `h5Pct` first call (builds the 30,000-hand 5-card table) | 73 |
| `oppDist('std')` / `('two')` / `('n7')` with tables already built | 74 / 66 / 79 |
| `oppDist('k8')` with tables already built | 749 |
| `oppDist` cold in a fresh copy: std / two / n7 / k8 | 87 / 101 / 163 / 743 |

An earlier scratch run of the same measurement gave 826 ms for `oppDist('k8')`. The committed
run above is the reference.

## CPU profile (diagnostic, Hold'em, 15 s)

Command: `node tools/measure/cpu-profile.mjs 15`. Output:
[`results/2026-10-31-cpu-profile-holdem.txt`](tools/measure/results/2026-10-31-cpu-profile-holdem.txt).
Used only to locate the long task. One run, sampled every 200 µs via the DevTools protocol
`Profiler` domain:
- Inclusive time in `oppDist` (line 1109) was 932 ms.
- Self time was 67 ms in the game's `evaluate` (line 703) and 353 ms in `splitsOf` (line 1095).
- About 0.65 s went to Playwright's in-page selector engine.
- The `evaluate:284` entry (884 ms) is Playwright's injected `page.evaluate`, not the game's evaluator.

Single run; treat it as directional, not a benchmark.

## Tests and coverage (TypeScript port)

Command: `npx vitest run --coverage`. Output:
[`results/2026-10-31-tests.txt`](tools/measure/results/2026-10-31-tests.txt).

| Metric | Value |
|---|---|
| Test files / tests | 4 / 36, all passing |
| Golden replay | 272 hands from 12 recorded sessions of the original game (6 home-game sessions, one per variant plus dealer's choice; 6 tournaments) replay with identical hand-history lines and stacks |
| Situations in the golden hands | 35 with side pots, 104 all-ins, 144 uncalled bets returned, 7 mucks, 4 tied pots, 74 two-of-three majority wins and 5 three-way splits (8-card game). No antes: covered by a unit test instead |
| Property tests (fast-check) | 300 random hands with random, often illegal, actions: chips conserved, no negative stacks, pot paid out. 500 random contribution layouts: side pots add up and only live contributors are eligible |
| Coverage of `src/engine`, `src/ai`, `src/sim` | Statements 88.65%, branches 83.03%, functions 91.07%, lines 90.04% (varies by about 0.1 point between runs, because the property tests draw new random cases each run) |
| Not covered by unit tests | `src/ui` (the browser layer), which the Playwright smoke test exercises instead |
| AA vs KK exact equity (As Ah vs Kd Kc, all 1,712,304 boards) | 81.255% (wins 1,388,072, ties 6,538) |

## Bot parity (TypeScript bots vs the original)

Commands: `node tools/golden/persona-stats.mjs` (original, in Chromium; 3,432 hands in 27.1 min,
output [`results/2026-10-31-legacy-persona-stats.txt`](tools/measure/results/2026-10-31-legacy-persona-stats.txt))
and `npx tsx tools/sim/parity.ts` (TypeScript; 3,400 hands in about 2 minutes, output
[`results/2026-10-31-bot-parity.txt`](tools/measure/results/2026-10-31-bot-parity.txt)).

Both play the same session plan with the same scripted hero: home Hold'em (8 sessions x 250
hands), home Poker + 3 Patti (4 x 100) and tournaments (4 x at least 250 hands, new
tournaments started as the hero busts). The test compares each persona's VPIP, PFR and
postflop aggression frequency; each must be within 3 standard errors of the difference
(floor: 3 percentage points). **Result: all 16 persona/game rows within tolerance.**

Caveats:
- Tournament personas have only about 300 to 740 hands each, so the bands are wide: this
  rules out large behaviour changes, not small ones. The widest passing gaps are Rock VPIP
  (10.5% vs 15.6%) and Trapper PFR (21.9% vs 15.6%).
- In home Hold'em, Nikhil's and Krish's aggression frequencies differ by about 6 to 7 points
  (z about 2.7, in opposite directions). That is inside the tolerance but more than chance
  usually gives. Each side ran only 8 sessions, and seating (how far each bot sits from
  the aggressive scripted hero) does not average out across so few sessions; the two
  sides also seat players differently. Not investigated further yet.
- The aggression factor (bets+raises / calls) is printed for reference but not tested: as a
  ratio of small counts it swings too much at these sample sizes.

## Freeze fix: before and after (Web Worker + coach on demand)

Same script, same settings as the Phase 1 baseline: `tools/measure/longtasks.mjs`, 60 s per
variant, hero opens a hint on every decision then calls, Chromium 141, same machine type.

- **Before** is the Phase 1 baseline: the original game, `node tools/measure/longtasks.mjs 60 1`
  and `... 60 4`.
- **After** is the new app's measurement build: `npx vite build --mode measure --outDir dist-measure-after`,
  `npx vite preview --outDir dist-measure-after --port 4176`, then
  `node tools/measure/longtasks.mjs 60 1 --app=http://localhost:4176/` and `... 60 4 --app=...`.

Outputs: [`longtasks-1x`](tools/measure/results/2026-10-31-longtasks-1x.txt),
[`longtasks-4x`](tools/measure/results/2026-10-31-longtasks-4x.txt) (before);
[`longtasks-app-after-1x`](tools/measure/results/2026-10-31-longtasks-app-after-1x.txt),
[`longtasks-app-after-4x`](tools/measure/results/2026-10-31-longtasks-app-after-4x.txt) (after).

### Main-thread long tasks (over 50 ms) in 60 s

| Variant | 1x before: count / worst | 1x after: count / worst | 4x before: count / worst | 4x after: count / worst |
|---|---|---|---|---|
| Hold'em | 5 / 645 ms | 1 / 50 ms | 77 / 3,132 ms | 75 / 117 ms |
| Poker + 3 Patti | 51 / 719 ms | 0 / none | 132 / 2,480 ms | 90 / 157 ms |
| Two boards | 34 / 675 ms | 3 / 99 ms | 155 / 3,476 ms | 87 / 196 ms |
| 8 cards | 128 / 627 ms | 1 / 58 ms | 97 / 2,509 ms | 100 / 199 ms |
| 7 cards | 104 / 603 ms | 2 / 50 ms | 127 / 3,022 ms | 90 / 181 ms |

### Where the work went (1x, median / max)

| Work | Before: on the main thread | After: in the worker (page not blocked) |
|---|---|---|
| Coach read, 8-card game | 295.9 / 539.6 ms on every hero turn | 387.2 / 678.4 ms, only when a hint is opened |
| Bot decision, 8-card game | 64 / 138.3 ms | 69.4 / 157.9 ms |
| Opponent-model tables | up to 645–719 ms, once per variant | about 1.27 s for all four variants, once per table |
| End-of-hand grading, 8-card game | (part of each turn) | 1,442 / 2,633 ms per hand, while the result shows |

### What this means, and what it does not

- At 1x, the 600–720 ms freezes are gone; the worst long task left is 99 ms.
- At 4x (an emulated slow phone, not a real device), the worst freeze goes from 2.5–3.5 s
  to under 200 ms. The count of 50–200 ms tasks stays similar. None of them falls inside
  the bots, the coach or the table building any more. The likely causes are rendering,
  animations and the measuring driver itself; that is the next thing to look at.
- Hands played in 60 s are about the same as before (for example, 9 vs 11 in the 8-card game
  at 1x), so this is not fewer hands doing less work.
- Grades are unchanged: `test/coach-lazy.test.ts` grades 98 decisions both at the time and
  later from snapshots, with identical results.

### A regression found and fixed on the way

The first measurement of the port (before the worker change) was slower than the original:
the Hold'em coach read was 19.4 ms median vs 2.4 ms, and the 8-card one 448 ms vs 296 ms
(output: [`longtasks-app-prefix-cryptorng-1x`](tools/measure/results/2026-10-31-longtasks-app-prefix-cryptorng-1x.txt)).

The cause: in live play every random number came from `crypto.getRandomValues`, which
measured about 0.3 M draws/s against 49 M for mulberry32 (a quick Node microbenchmark, run
while a browser measurement was also running, so treat the exact figures as rough).

Fixed in `2e6dad5`: each random segment now gets a fast generator seeded from crypto, and
the deck still draws every card from crypto. The after numbers above include this fix.

## Simulator (TypeScript engine and bots, headless)

Command: `npx tsx tools/sim/simulate.ts 90` (90 s budget per game). Output:
[`results/2026-10-31-simulator.txt`](tools/measure/results/2026-10-31-simulator.txt).

Hand counts are chosen per game from a 20-hand timing pilot so each game fits the budget.
The pilot overestimates Hold'em's per-hand cost (JIT warm-up), so Hold'em used 63 s of its 90.

| Game | Hands | Runtime | ms per hand |
|---|---|---|---|
| Hold'em (home) | 4,050 | 63.3 s | 15.6 |
| Poker + 3 Patti | 350 | 73.8 s | 210.8 |
| Two boards | 300 | 85.3 s | 284.3 |
| 7 cards | 150 | 82.3 s | 548.6 |
| 8 cards | 150 | 103.5 s | 690.2 |
| Tournament (Hold'em) | 7,900 | 56.5 s | 7.2 |

Per-persona VPIP, PFR, aggression, went-to-showdown and bb/100 with 95% confidence
intervals are in the output file. How to read them:
- **Opponent.** The win rates are against the scripted hero, which plays loose and raises a
  lot on purpose. They show how each persona exploits that player, not who is the strongest
  overall. For example, in home Hold'em Krish, Nikhil and Rohit all win about 230–260 bb/100
  with overlapping intervals, and Venky (who calls almost everything) loses. "Nikhil beats
  the weak personas" cannot be claimed from this.
- **Samples.** The split games have only 150–350 hands, so their win-rate intervals are very
  wide (often several hundred bb/100).
- **Throughput.** The split games run 13–44x slower per hand than Hold'em, because every bot
  decision plays the whole hand out many times (the reason for the Web Worker in the app).

## AI hand review eval

Commands:
- mocks, no network: `npx tsx tools/review/eval.ts --mock`, `--mock-lazy` and `--mock-chain`;
- live: the "AI review eval (live)" workflow, which runs
  `npx tsx tools/review/eval.ts --live https://sumer-riverroom.vercel.app/api/review [--model <id>]`.

The 20-hand eval set has 10 hands where the app's coach found a mistake and 10 played well.
The score is the mean of four checks:
- the answer is schema-valid;
- the grade is within one step of the coach's;
- a mistake is reported if and only if the coach found one;
- the mistake's street is named.

The reference is the app's own coach, so the score measures agreement with it, not poker
truth.

### Mock models (pipeline checks, in CI)

| Run | Score | What it shows |
|---|---|---|
| Perfect mock | 100.0% (20/20 valid, 20/20 grade, 20/20 mistake, 10/10 street) | The scoring pipeline works end to end |
| Lazy mock ("good, no mistake" every time) | 57.1% (20/20 valid, 10/20 grade, 10/20 mistake, 0/10 street) | The scorer separates good answers from bad ones |
| Mock chain (free models fail on some hands) | 100.0%; answered by free 15, paid 5 | The chain falls through to the next model on a rate limit or invalid output |

### Live: OpenRouter, deployed endpoint, 2026-11-01

Outputs (each line per hand, plus which models were tried and how each attempt ended):
[run 1](tools/measure/results/2026-11-01-review-eval-live-run1.txt) and
[run 2](tools/measure/results/2026-11-01-review-eval-live-run2.txt).

**The chain as shipped (run 2, after the Nemotron fix):** Gemma 4 26B (free) > Nemotron 3.5
Super (free) > Gemini 2.5 Flash Lite (paid).

| | Value |
|---|---|
| Score | **87.1%** (20/20 valid, 16/20 grade, 16/20 mistake, 9/10 street) |
| Who answered | **free 20, paid 0, built-in fallback 0** (all by Nemotron) |
| Paid-model calls | 0 |
| Response time, full request | median 5,139 ms, max 14,711 ms |

Latency per model, from each attempt as the server timed it:

| Model | Run | Attempts | Outcome | Valid answers: median / max |
|---|---|---|---|---|
| `google/gemma-4-26b-a4b-it:free` | 2, chain | 20 | 429 from the provider on all 20 | (none) |
| `nvidia/nemotron-3.5-super-vl:free` | 2, chain | 20 | 20 valid | 4,734 ms / 14,342 ms |
| `nvidia/nemotron-3.5-super-vl:free` | 2, alone | 20 | 20 valid (score 80.0%) | 4,644 ms / 7,259 ms |
| `google/gemma-4-31b-it:free` | 2, alone | 20 | 429 from the provider on all 20 (score 0%) | (none) |
| `google/gemini-2.5-flash-lite` (paid) | 1, chain | 20 | 16 valid, 4 rate-limited | 678 ms / 1,309 ms |

**What the runs showed, and what changed.**
- *Run 1* (before the fix): Gemma 26B and Gemma 31B were rate-limited on every request (429
  "Provider returned error"). Nemotron, on the same OpenRouter account, was not, so the
  limit was Google's free Gemma capacity, not the account.
  - Nemotron was cut off on all 20 hands: its thinking used up the 500-token limit.
  - So the paid model answered 16 hands and the built-in review covered 4. Score 71.4%,
    median response 3,746 ms.
- *Fix:* reasoning models get an 800-token thinking budget on top of the 500 for the answer.
  It is free, because only free models reason in this chain.
- *Run 2:* every hand was answered for free.
- *Second free model:* Nemotron (another provider) beat Gemma 4 31B, which could not answer
  at all, so Nemotron stays second.
- *Same model, two scores:* Nemotron scored 80.0% alone and 87.1% in the chain, on the same
  20 hands. These are sampled answers (temperature 0.2), so a single 20-hand run moves by
  several points.

**Not measured here:** the cost of the paid calls in run 1 (16 calls). OpenRouter reports the
cost per call in the function logs, which this environment cannot read.

### Prompt size

Command: `npx tsx tools/review/prompt-size.ts` (the "before" number used the same method on
the previous prompt code). Output:
[`results/2026-11-01-review-prompt-size.txt`](tools/measure/results/2026-11-01-review-prompt-size.txt).

| | Characters sent per review (system + user), 20 eval hands |
|---|---|
| Before (Anthropic version) | mean 2,833 (min 2,278, max 3,947); system prompt 988 |
| After (compact prompt) | mean 1,683 (min 1,233, max 2,699); system prompt 486; 40.6% fewer |

Tokens depend on each model's tokenizer and are not converted here.

## Tests with Postgres (current suite)

Command: `TEST_DATABASE_URL=postgresql://…/riverroom_test npx vitest run --reporter=verbose`
against a local Postgres 16, after `npm run db:migrate`. Output:
[`results/2026-10-31-tests-with-postgres.txt`](tools/measure/results/2026-10-31-tests-with-postgres.txt).

| Metric | Value |
|---|---|
| Test files / tests | 10 / 72, all passing (5 full runs in a row passed) |
| Without `TEST_DATABASE_URL` | 71 pass, the storage test is skipped |
| Coverage (`npx vitest run --coverage`, with Postgres) of everything outside the page: engine, bots, simulator, coach, AI review, ledger, server | Statements 88.88%, branches 82.27%, functions 91.58%, lines 91.52%. Per file: [`results/2026-10-31-coverage-current.txt`](tools/measure/results/2026-10-31-coverage-current.txt). Lowest: `src/ai/equity.ts` at 60.07% of statements; the uncovered part is mostly the multi-opponent range equity (`equityVsMulti`) that split-game bots use, which the unit tests rarely reach |
| Storage test (`test/store.test.ts`) | Real server, real Postgres, 3 clients, 8+ hands; one player leaves mid-session. Stored 7 hands with 5 results each and 9 ledger entries in the saved run. The settlement read from Postgres equals the in-memory one. The leaver's cash-out equals their buy-ins plus their stored hand results. Tokens are stored only as hashes. 0 failed writes. Passed 6 runs in a row on its own, about 3 s each |

## Multiplayer: no-card-leak check

Command: `npx vitest run test/server.test.ts --reporter=verbose`, run 5 times. Output:
[`results/2026-10-31-mp-leak-check.txt`](tools/measure/results/2026-10-31-mp-leak-check.txt).

A hook compares every view the server is about to send with the real game state: a player
may only see their own cards, plus cards turned face up for everyone.

| Run | Views checked (12 hands, 3 clients + 2 bots) | Leaks |
|---|---|---|
| 1–5 | 1,445 / 1,362 / 1,365 / 1,312 / 1,359 | 0 in every run |

Mutation check: changing one line so that a player waiting for a seat sees that seat's
cards makes the test fail in 3 of 3 runs.

## Settlement (fewest payments)

Command: `npx tsx tools/ledger/bench-settle.ts 200` (200 random nights per size; balances
from −$10 to +$10 in 50-cent steps, a synthetic distribution). Output:
[`results/2026-10-31-settle-bench.txt`](tools/measure/results/2026-10-31-settle-bench.txt).

| People | `settle()` mean / worst | Payments: exact vs greedy | Exact used fewer payments on |
|---|---|---|---|
| 6 | 0.07 ms / 0.8 ms | 907 vs 958 | 51 of 200 nights |
| 10 | 0.18 ms / 2.2 ms | 1,464 vs 1,717 | 170 of 200 nights |
| 16 (largest exact size) | 10.65 ms / 20.7 ms | 2,236 vs 2,836 | 198 of 200 nights |

How often exact beats greedy depends on how often balances cancel out within subgroups.
Round-number balances, as here, make that common. The property test in
`test/settle.test.ts` checks the minimum against brute force (400 random cases).

## Lighthouse (local production build)

Command: `npm run build && npx vite preview --port 4181`, then
`node tools/measure/lighthouse.mjs http://localhost:4181/ tools/measure/results/lighthouse 3 95`
(Lighthouse 13.5.0, mobile preset with default throttling, Chromium 141). Output:
[`results/2026-10-31-lighthouse-local.txt`](tools/measure/results/2026-10-31-lighthouse-local.txt);
full reports for run 1: [`results/lighthouse/`](tools/measure/results/lighthouse/).

| Page | Performance | Accessibility | Best practices | SEO |
|---|---|---|---|---|
| `/` (game, start screen) | 90, 90, 90 | 100, 100, 100 | 100, 100, 100 | 100, 100, 100 |
| `/mp.html` (play with friends) | 100, 100, 100 | 100, 100, 100 | 96, 96, 96 | 100, 100, 100 |

- Before two fixes, the first measurement was accessibility 95 on `/`, because of small
  captions at a 4.32:1 contrast ratio, and SEO 91 on both pages, because there was no
  `robots.txt`.
- Best practices 96 on `/mp.html`: the page logs a console error when it cannot reach a
  multiplayer server, and none runs in this local measurement.
- These are local numbers on a cloud VM. The live site is measured below.

## Lighthouse (live site)

The "Live smoke test" workflow runs `node tools/measure/lighthouse.mjs https://sumer-riverroom.vercel.app/ lighthouse 3 95`
after each production deploy, on a GitHub-hosted runner. Each score is also posted as an annotation. Output, from
[run 41171217087](https://github.com/SumerThakur1771/RiverRoom/actions/runs/41171217087) (commit `3c8c09d`):
[`results/2026-10-31-lighthouse-live.txt`](tools/measure/results/2026-10-31-lighthouse-live.txt).

| Page | Performance | Accessibility | Best practices | SEO |
|---|---|---|---|---|
| `/` | 83, 84, 76 | 100, 100, 100 | 100, 100, 100 | 100, 100, 100 |
| `/mp.html` | 100, 100, 100 | 100, 100, 100 | 96, 96, 96 | 100, 100, 100 |

Best practices 96 on `/mp.html` has the same cause as locally. The live page has no
multiplayer server to connect to yet (the Render service is not set up), so it logs a connection error.

## Accessibility of in-game screens (axe-core)

Command: `node tools/ui/axe-table.mjs http://localhost:4181/` (axe-core 4.14.0, WCAG 2.1 A and
AA rules). Output: [`results/2026-10-31-offline-and-axe.txt`](tools/measure/results/2026-10-31-offline-and-axe.txt).

| Screen | Desktop | Phone |
|---|---|---|
| Table, your turn | 0 violations | 0 violations |
| Hint panel open | 0 violations | 0 violations (was 1 before the fix: the scrollable hint panel was not keyboard-focusable) |
| End-of-hand review | 0 violations | 0 violations |

## Offline play (service worker)

Command: `node tools/ui/offline.mjs http://localhost:4181/ 60`. Output:
[`results/2026-10-31-offline-and-axe.txt`](tools/measure/results/2026-10-31-offline-and-axe.txt).

On a phone-sized page:
- The manifest loads, with display "standalone" and 4 icons.
- The service worker controls the page and has 16 files cached.
- With the network cut, the page reloads and plays to hand #3 in 60 s, with 0 page errors.
- The multiplayer page also opens offline (it needs the network to play).

## Deck shuffle: exact uniformity (live play)

Commands: `node tools/measure/shuffle-bias.mjs` (exact arithmetic) and
`npx vitest run test/shuffle.test.ts --reporter=verbose`. Output:
[`results/2026-11-01-shuffle.txt`](tools/measure/results/2026-11-01-shuffle.txt).

| | Old: `x % n` on 32-bit crypto values | New: rejection sampling |
|---|---|---|
| Step sizes (2..52) with any bias | 46 of 51 | 0 |
| n = 52 | 48 results get 82,595,525 inputs, 4 get 82,595,524 (relative bias 1.211e-8) | every result gets 82,595,524 inputs; 48 of 2^32 inputs are redrawn (probability 1.118e-8) |
| Exhaustive check on an 8-bit source, every n up to 52 | fails (2 tests fail when `% n` is put back) | passes |
| Chi-square, 208,000 draws of 0..51; top and bottom card of 52,000 live shuffles | | below the 1-in-a-million threshold (114.5 at 51 degrees of freedom) |

Seeded play keeps the original shuffle; the 272-hand golden replay still passes unchanged.

## Web Analytics on the live site

Command: `node tools/ui/analytics-check.mjs https://sumer-riverroom.vercel.app`, run after
each deploy by the "Live smoke test" workflow. Output:
[`results/2026-11-01-web-analytics-live.txt`](tools/measure/results/2026-11-01-web-analytics-live.txt)
([run 41349679211](https://github.com/SumerThakur1771/RiverRoom/actions/runs/41349679211)).

| Page loaded | Analytics script | Page views sent | URL recorded |
|---|---|---|---|
| `/?seed=analytics-check` | 200 | 1 (200) | `https://sumer-riverroom.vercel.app/` |
| `/mp.html?code=ABCDEF` | 200 | 1 (200) | `https://sumer-riverroom.vercel.app/mp.html` (the invite code is not sent) |

The tracker sends nothing from automated or headless browsers. The check presents itself as
a normal desktop Chrome; the first two runs, without that, saw the script load and no page
view. Visitor numbers are not claimed: this only shows that tracking works.

## Multiplayer on production

The "Live smoke test" workflow runs this after each deploy:
1. It polls the Render server's `/health` until it reports the deployed commit, which also
   wakes the free server.
2. It runs `node tools/ui/mp-smoke.mjs https://sumer-riverroom.vercel.app/mp.html 2 --expect-stored`.

Output: [`results/2026-11-01-multiplayer-live.txt`](tools/measure/results/2026-11-01-multiplayer-live.txt)
([run 41351661571](https://github.com/SumerThakur1771/RiverRoom/actions/runs/41351661571), commit `9b7086c`).

| Check | Result |
|---|---|
| Render server (free, Virginia) runs the commit | yes; it answered 31 s after the first request (time to wake and/or finish deploying, not separated) |
| Two browsers (desktop, phone) create and join table M2F9CY on the live page | yes |
| Hands played | 2 started, 1 finished |
| Reload mid-game | same seat and same table, by session token |
| Settle up | computed from the ledger read back from Neon. Same balances as the server's memory. Saved: 1 finished hand, 2 buy-ins, 0 cash-outs |
| Table opened after the "Start a table" click (server already awake) | 224 ms |

## Not measured yet

- Vercel Web Analytics visitor numbers (tracking is verified working; no real-visitor data yet).
- Real-device phone performance.
- Persona win rates against each other (head-to-head), as opposed to against the scripted hero.
- Users and hands played by real people.
