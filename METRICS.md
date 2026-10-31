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

## Not measured yet

- Lighthouse scores (performance, accessibility).
- Real-device phone performance.
- Test counts and coverage: there are no tests in the repo yet.
- Simulator throughput and persona win rates.
- Users and hands played by real people.
