# River Room: plan

Built from the findings in [ANALYSIS.md](ANALYSIS.md). Effort figures are **estimates**, not
measurements. Each step ends with: typecheck, lint, tests, build, Playwright screenshots
(desktop and phone), commit, push, short report.

## Critique of the proposed plan

| Proposal | Verdict | Why |
|---|---|---|
| a) Vite + TS split into engine/ai/coach/ui, localStorage, Vercel | **Keep, but re-scope** | The hard part is not moving files. It is making the engine a pure state machine that does not await animations (ANALYSIS §1). Do that first, with tests, before splitting AI/coach/UI. |
| b) Vitest: exhaustive evaluator, fast-check side pots, AA vs KK, rule tests, CI + coverage | **Keep, move earlier and spread it out** | Tests should land with each extracted module, not as a later phase. Replace the Monte Carlo AA vs KK check with **exact enumeration** (1,712,304 boards): an exact oracle, no flaky tolerance. Report coverage; don't chase a target number. |
| c) Web Worker, evaluator benchmark, lookup-table evaluator | **Keep the Worker, drop the lookup table unless measurements justify it** | Measured: the freezes come from `oppDist` (600–720 ms) and `coachContext` (296 ms median in the 8-card game), not the evaluator (2.15–2.29 M hands/s, 67 ms self-time in a 15 s profile). A faster evaluator would not fix what users see. |
| d) Headless simulator, 100K hands, persona stats, "Nikhil beats weak personas" test | **Keep, with honest sample sizes** | Split-game bot decisions take 18–64 ms median. In the measured 8-card run there were 130 bot decisions in 11 hands (about 12 per hand). 100K hands × 12 × 64 ms comes to about 21 hours of single-core compute. Pick hand counts per variant from measured simulator throughput. Make the regression test assert only what a confidence interval supports. |
| e) Socket.IO server-authoritative multiplayer + Supabase + Fly/Render + 3-client test | **Keep, split in two** | e1: rooms, reconnect and bots, all in memory, with the integration test. e2: Postgres history and ledger. e1 alone is a complete backend story; e2 adds the data-model story. Hosting and database are your call (I'll ask). |
| f) Claude review on a server route, streaming, rate limit, zod, 20-hand eval | **Keep, and do it before e** | Smaller, independent, and it needs only one serverless route next to the Vercel deploy. It also replaces `window.claude.sample` (the one host-only feature) before multiplayer. Needs an API key: I'll ask. |
| Tier 3: PWA, Lighthouse a11y 95+, PostHog, real usage | **Keep PWA and a11y, make analytics conditional** | Cards need `aria-label`s first (ANALYSIS §6). Analytics only matter with real users. Your home game is the real user base once multiplayer exists. |
| Skip React Native, more variants, GTO claims | **Agree** | Also skip a React rewrite of the UI: a big diff with little signal. Typed modules plus tests show more. |

**Missing from the proposal:**
- **Seeded replay of any hand** (seed + action log). This gives debugging, shareable hand
  histories and a server reconnect story almost for free once the RNG is injectable.
- **Schema validation of saved data** with a migration from the current `river-room-v2` keys,
  so existing progress isn't lost.
- **ESLint + Prettier** in CI.
- **The `[hidden]` host-skeleton dependency** (ANALYSIS §1). The standalone build must
  include base styles.
- **Error reporting** instead of the silent 600-iteration break.

## Ordered steps

### Tier 1: one deployable, tested, measured app

| # | Step | Effort | Acceptance criteria | Resume value |
|---|---|---|---|---|
| 1 | **Scaffold**: Vite + TypeScript (strict for new code) + ESLint + Prettier + Vitest + Playwright + GitHub Actions. Legacy page served unchanged with base styles. | 0.5 d | CI green on push. Playwright loads the legacy page with zero console errors and saves desktop and phone screenshots. | Tooling and CI |
| 2 | **Injectable RNG + golden traces**: minimal patch to the legacy file (no behavior change), separate `deck` and `ai` streams, a recorder for a few hundred seeded bot-only hands per variant. | 1 d | Same seed gives byte-identical traces in two runs. Unseeded play still uses `crypto` for the deck. Traces committed. | Testing nondeterministic code |
| 3 | **Evaluators to TS**: 5-card/7-card, 3 Patti, hand-5, with exhaustive tests and exact equity enumeration. | 1–1.5 d | 2,598,960 and 22,100 hand counts match. 7,462 / 741 distinct classes. AA vs KK exact equity asserted. Golden traces unchanged. | Algorithms and testing |
| 4 | **Pure engine**: deal, blinds, betting, side pots, showdowns and splits as `(state, action, rng) → (state, events)`. The UI becomes an event player. | 3–4 d | Rule tests for every row in ANALYSIS §2. fast-check properties (chips conserved, eligibility, no negatives). Golden traces match. | State machines, separation of concerns |
| 4b | **Rule fixes**, one commit each with a failing-then-passing test: engine-side min-raise validation, cumulative short all-in reopen, safety break throws, deck-capacity assert, rejection-sampled shuffle. | 1 d | Each test fails on the commit before the fix. Trace differences explained in the commit message. | Debugging and rules depth |
| 5 | **AI and coach to TS modules** on top of the engine. | 2–3 d | Golden traces unchanged, so persona behavior is unchanged. Typecheck clean. | Refactoring safely |
| 6 | **Persistence and deploy**: localStorage adapter (`window.claude` optional), zod-validated snapshot with migration, escaped style values, Vercel deploy. | 1 d | An old `river-room-v2` save loads. A malicious snapshot cannot inject markup (test). Public URL works on desktop and phone. | Shipping, security basics |
| 7 | **Web Worker + measured fix**: `coachContext`, bot equity and `oppDist` move off the main thread. `oppDist` tables precomputed at build time. | 2 d | Same `tools/measure/longtasks.mjs` run before/after, both recorded in METRICS.md. Target: no long task over 100 ms in Hold'em, Standard or Two boards at 1× (set only after the "after" numbers exist). | Profiling and concurrency |
| 8 | **Headless simulator + persona stats**: VPIP, PFR, aggression, showdown %, bb/100 with confidence intervals. | 2 d | Hand counts chosen from measured throughput. The regression test asserts only what the CI supports and is stable across 10 consecutive runs. | Simulation and statistics |

**Pause at end of Tier 1:** summary, METRICS.md updated, DESIGN.md sections, 5 interview
questions with model answers.

### Tier 2: backend (ask before starting)

| # | Step | Effort | Acceptance criteria | Resume value |
|---|---|---|---|---|
| 9 | **AI hand review on a server route**: streaming, server-side key, per-user rate limit, zod-validated JSON, 20-hand eval set with a written scoring rubric. | 1.5–2 d | Key never in the client bundle (grep test). Rate limit returns 429 in a test. Eval score recorded in METRICS.md with the exact command. | LLM integration done responsibly |
| 10 | **Multiplayer e1**: Node + TS + Socket.IO server reusing the engine, invite-code rooms, reconnect, bots fill empty seats, in-memory state. | 5–7 d | A 3-client integration test plays full hands. A client never receives another player's hole cards before showdown (test inspects every message). Reconnect resumes the same seat. | Server-authoritative backend, anti-cheat |
| 11 | **Multiplayer e2**: Postgres (users, hand history, buy-in/rebuy ledger, settlements). | 3–4 d | Ledger always sums to zero per session (property test). Migrations checked in. | Data modelling, SQL |

### Tier 3: polish (after Tier 2)

PWA install, card `aria-label`s and keyboard focus audit, Lighthouse a11y run with the
score recorded (no target claimed until measured), self-hosted fonts and a strict CSP.
Analytics only once real people are using it.

## Decisions I need from you before Tier 1 code

1. **Engine-first refactor (step 4) instead of a file split first.** Tradeoff: about 3–4 days
   on an invisible change before any visible improvement. In return, everything after it
   (simulator, server, tests) gets easier.
2. **TypeScript strictness:** strict for engine/AI/coach. The UI layer is plain JS with
   `// @ts-check` at first, so the refactor doesn't stall on typing about 2,000 lines of DOM code.
3. **Keep `legacy/river-room.html` in the repo** as the reference build and trace source.
   Delete it once the new app replaces it.

## Tier 1: what was done (2026-10-31)

The order agreed after Phase 1 was: headless engine with golden traces, the two rule fixes,
the Vite UI deployed early, tests and CI, then the freeze fix. Mid-way the scope was
narrowed: exact golden matching for the rules engine only; statistical parity for the bots
and coach.

| Step | Result | Commits |
|---|---|---|
| Engine port + golden traces | 272 recorded hands replay exactly (logs and stacks) | `f8d2762` |
| Rule fixes | Engine-side minimum raise; cumulative short all-ins re-open betting (TDA). Each with a test that fails before and passes after | `3fa51fd`, `f1b239c` |
| Bots | Ported; VPIP, PFR and aggression within 3 standard errors of the original for all 16 persona/game rows | `487424e`, `18eab21` |
| UI on the new engine | Vite build, live at https://sumer-riverroom.vercel.app | `487424e` |
| Tests + CI | 43 tests in 5 files, about 89% statement coverage of engine/bots/simulator; CI on every push; live smoke test after each deploy | `18eab21`, `12979cf` |
| Freeze fix | Bots, coach and tables in a Web Worker; coach on demand. At 1x worst long task 719 ms → 99 ms; at 4x 3.5 s → under 200 ms. Grades unchanged | `5d267fd`, `2e6dad5`, `b936163` |
| Simulator | 150 to 7,900 hands per game, about 1–1.7 minutes each; per-persona stats with confidence intervals | see METRICS.md |

**Changed from the plan.**
- The coach and UI are still plain JavaScript, not strict TypeScript. They were moved, not
  rewritten, to get a working app fast. Typing them is the first polish item.
- Seating now uses an unbiased Fisher-Yates shuffle; the original's biased sort trick
  depended on the JavaScript engine.
- A performance regression introduced by the port (crypto RNG on every draw) was found by
  the measurements and fixed.

**Left for later (polish).**
- Type the coach and UI.
- Investigate the remaining 50–200 ms long tasks at 4x (rendering and animation).
- Self-host fonts and add a CSP.
- Card accessibility labels and a Lighthouse run.
- Bigger parity samples for the tournament personas.
