# River Room: Phase 1 analysis

This is an audit of the current game before any refactor. The audited file is
[`legacy/river-room.html`](legacy/river-room.html). It is an unchanged copy of the single-file
build published as a Claude artifact (version 31): 3,914 lines, 306,409 bytes, 93,101 bytes
gzipped. Line numbers below refer to that file.

Every number in this document comes from a command in [METRICS.md](METRICS.md). Anything not
measured yet is marked **not measured**.

---

## 1. Staff engineer: structure and maintainability

**What it is.** One HTML file with CSS at lines 6–474, markup up to line 672, and one
script IIFE at lines 673–3914 holding about 215 top-level functions. Everything shares one
mutable global game state, `S` (line 1422).

**Main finding: game logic and animation are interleaved.** The engine is a chain of
`async` functions that await animations:
- `applyAction` awaits `betFly` (lines 1808, 1826).
- `bettingRound` awaits render pauses (line 2733).
- `playHand` awaits card-dealing flights (lines 3111–3122).

So the rules cannot run without a DOM, which blocks three things:
- unit-testing the rules,
- a headless simulator,
- a server-authoritative multiplayer server (the server needs the same rules with no DOM).

**Consequence for the plan.** "Split into engine/ai/coach/ui folders" undersells the work.
The real change is an inversion: the engine becomes a pure state machine,
`(state, action, rng) → (state, events)`, and the UI plays the events back as animations.
Moving functions into files without that inversion would give the same coupling in more files.

**Randomness is not injectable.**
- The deck uses `crypto.getRandomValues` (line 756).
- Bots, sampling and persona noise call `Math.random` directly: `rnd`/`pick` (lines 684–685),
  `sampleFrom` (line 824), `randCards` (line 1074), `aiAction` (line 2037).

No game can be replayed, so neither "golden traces" nor regression tests are possible until
an RNG is passed in.

**Hidden host dependency.**
- The file starts at `<title>`, with no `<!doctype>`, and relies on the artifact host's page
  wrapper for `[hidden]{display:none}`.
- Opened directly in Chromium, the hidden `#endOv` overlay still covers the page and
  intercepts clicks. I found this while building the measurement harness.
- Any standalone build must supply its own base styles.

**Persistence** is split:
- `localStorage` for settings, progress and the table snapshot (lines 1416–1417).
- The host's `window.claude` db/user/sample capabilities when available (lines 3877–3899).

Snapshot data is used without schema validation (line 1478).

**What is good:**
- Hand evaluation is a compact pure function.
- The fixed-seat home game is well isolated in data (`HOME_FRIENDS` line 1357,
  `DEALER_PICKS` line 1049, `TYPES` line 1328).
- Errors inside a hand are caught and reported instead of freezing the loop.

## 2. Poker rules expert

Checked by reading the code paths. Items marked "verified" were also checked by running
something (see METRICS.md).

### Correct (keep, and cover with tests)

| Rule | Where | Notes |
|---|---|---|
| 5-card hand ranking | `evaluate` L703 | **Verified exhaustively.** All 2,598,960 hands land in the standard category counts, and there are exactly 7,462 distinct hand values (the known number of 5-card equivalence classes). |
| 3 Patti ranking (Trail > Pure sequence > Sequence > Color > Pair > High card; A-K-Q, then A-2-3, then K-Q-J) | `tpScore` L1053 | **Verified exhaustively.** All 22,100 hands give the standard counts (52 / 48 / 720 / 1,096 / 3,744 / 16,440), with 741 distinct scores. |
| Heads-up blinds: button posts the small blind | L3070 | `sbIdx = button` when 2 players remain. |
| First to act: left of BB preflop, left of button after | L2712 | Heads-up this gives button-first preflop and BB-first after the flop, which is correct. |
| Deal order starts left of the button | L3111 | |
| Side pots, with folded players' chips staying as dead money | `buildPots` L2686 | Layered by smallest live contribution. Leftover with no live claimant joins the last pot. |
| Odd chip goes to the first winner left of the button | L2819–2824 | Winners sorted by distance from the button. Remainders are paid in 10¢ units in the home game. |
| Short all-in raise does not reopen betting for players who already acted | L1813 | They may call or fold but are marked `raiseLocked`. |
| Minimum raise stays at the last full raise size | L1812 | |
| Split games: half/half for `std`, `two`, `n7`; 2-of-3 majority for `k8`, thirds when three players win one part each | `showdownMulti` L2976 | Remainders go to the poker part (L3018–3022). |

### Bugs and gaps (each fix gets its own commit with a failing-then-passing test)

1. **The engine does not enforce the minimum raise** (L1810–1813).
   - `applyAction` accepts any `to > currentBet`.
   - An under-sized raise by a player who is not all-in is then processed like a short all-in:
     it locks the other players' raise option.
   - Today the callers clamp sizes (`raiseTo` L1833, plus the UI), so normal play does not hit this.
   - A server that accepts client actions must validate inside the engine, not the caller.
2. **Cumulative short all-ins never reopen the betting** (L1811–1813).
   - Each short raise is compared alone against `S.minRaise`.
   - Under the usual cardroom rule, if several short all-ins add up to a full raise, a player
     who already acted may re-raise.
   - Here that player stays `raiseLocked`. Rare, but it is a rules bug.
3. **Silent safety break** (L2736): after 600 iterations the betting round just ends.
   - That hides engine bugs instead of reporting them.
   - It should throw in tests and log in production.
4. **Moving button, not dead button** (L3069 `nextAlive(S.button)`).
   - When players bust, someone can skip a big blind or post it twice.
   - Fine for a friendly home game; document it as a rule choice, not a bug.
5. **No deck-capacity check** for 8-card games.
   - The `k8` deal needs 8 × players + 5 board cards.
   - The home table is fixed at 5 players (45 cards), so it cannot happen today.
   - A sixth seat would need 53 cards and break. Add an assertion.
6. **Shuffle modulo bias** (L757): `r % (i + 1)` on 32-bit values.
   - The bias is at most 52 / 2³² ≈ 1.2 × 10⁻⁸ per draw, so negligible in practice.
   - Rejection sampling removes it, and a server should use that.
   - Seat and name order use `sort(() => Math.random() - 0.5)` (L1481, L1487, L1488), which is
     biased but cosmetic.

## 3. QA: test strategy

**Today:** there are no automated tests in the repository. Earlier sessions used ad-hoc
browser harnesses (scenario injection and random-click stress runs). They lived outside this
repo and are not evidence of anything here.

**Strategy:**
- **Inject one RNG interface with separate streams**, at least `deck` and `ai`. With separate
  streams, a change in bot logic does not change which cards come out, so golden traces stay
  comparable across AI changes. Use a small seeded generator (mulberry32 or xoshiro128\*\*)
  in tests and `crypto` in production.
- **Golden traces before the refactor.**
  - Patch the legacy file minimally, RNG only, and record a few hundred seeded bot-only hands
    per variant: actions, pots, payouts, final stacks.
  - Replay after each refactor step and explain every difference. The only expected differences
    are the rule fixes above.
- **Exhaustive oracles where cheap:**
  - All 2,598,960 five-card hands, about 1.1 s in Node.
  - All 22,100 three-card hands.
  - Exact preflop all-in equities by enumerating all 1,712,304 boards. This is a better
    oracle than Monte Carlo for "AA vs KK ≈ 82%".
- **Property tests (fast-check):**
  - Chips are conserved.
  - Every pot's eligible players contributed to it.
  - No stack goes negative.
  - Payouts equal contributions.
  - Odd chips land left of the button.
- **Rule tests:** one test per row of section 2, plus the bug cases.
- **Statistical tests for bots:** assert win-rate claims only with a sample large enough that
  the confidence interval excludes zero. Otherwise the test is flaky by design.

## 4. Performance engineer (measured)

Setup: Chromium 141 headless, Intel Xeon @ 2.80 GHz, 4 vCPU.
- An instrumented copy of the game played 60 s per variant.
- The hero opened a hint on every decision and then called.
- A `PerformanceObserver` recorded every main-thread long task (>50 ms), and wrappers timed
  the synchronous part of the key functions.
- Full method and the 4× CPU-throttled run (a rough stand-in for a mid-range phone, not a
  real device) are in METRICS.md.

| Variant | Long tasks in 60 s | Worst long task | `coachContext` median / max | Bot decision median / max |
|---|---|---|---|---|
| Hold'em | 5 | 645 ms | 2.4 / 19 ms | 0.7 / 6 ms |
| Poker + 3 Patti | 51 | 719 ms | 57 / 157 ms | 23 / 96 ms |
| Two boards | 34 | 675 ms | 44 / 120 ms | 18 / 66 ms |
| 8 cards (k8) | 128 | 627 ms | 296 / 540 ms | 64 / 138 ms |
| 7 cards (n7) | 104 | 603 ms | 98 / 165 ms | 42 / 97 ms |

**Findings:**
1. **The ~600–720 ms freezes come from `oppDist`**, the split-game opponent model.
   - `runLoop` schedules it with `setTimeout` (L3237), with the comment "work out the odds in
     the background". It actually runs on the main thread.
   - In Node, `oppDist('k8')` alone takes about 745 ms.
   - At 4× CPU slowdown these freezes reach 2.5–3.5 s.
   - Each variant's table is computed once per page load, and each computation freezes the
     page. This happens in every home-game session, even one that only plays Hold'em.
   - I first guessed the one-time 3 Patti table build was the cause; it measures at only
     39 ms, so that guess was wrong.
2. **The coach analysis runs on every hero turn, even when no hint is opened** (L2726).
   - `coachContext` is the biggest repeated blocker: 296 ms median in the 8-card game.
   - It also runs when hints are switched off, because it feeds the end-of-hand grading.
   - At 4× CPU slowdown its 8-card median is 2,078 ms: a two-second freeze on every hero turn.
3. **Bot decisions block in split games:** 64 ms median and 82 of 130 decisions over 50 ms
   in the 8-card game.
4. **The 5-card evaluator is not the bottleneck.**
   - It runs at 2.15–2.29 M hands/s (5-card) and 1.62–1.94 M hands/s (7-card) in Node.
   - A CPU profile of a Hold'em run shows the game's `evaluate` at 67 ms self-time over 15 s.
   - `splitsOf` (array allocation while enumerating card splits) shows 353 ms in the same profile.
   - A lookup-table evaluator would make a nice benchmark but would not fix the blocking users see.

**Implication:**
- Move `coachContext`, bot equity and `oppDist` to a Web Worker.
- Ship `oppDist` as a precomputed table: it depends only on the variant and a seed.
- Measure again with the same script.

**Measurement caveat:** Playwright's polling runs inside the page (about 0.65 s of selector
queries in a 15 s profile). It is spread thin and was not attributed to any long task, but the
numbers are from an automated session, not a human one.

## 5. Security

- **All cards live in the client** (`S.players[i].cards`, `S.deck`). Anyone can read them in
  devtools. That is fine for a single-player trainer and disqualifying for real-money or
  friends-online play. Multiplayer must be server-authoritative:
  - The server shuffles (crypto RNG with rejection sampling), deals, and validates every action
    with the same engine.
  - Each client receives only public state plus its own hole cards.
  - Showdown reveals are sent only when the rules reveal them.
- **Unescaped interpolation:**
  - Player `color` from the saved snapshot is inserted into `style="--pc:${p.color}"` with
    `innerHTML` (L1511, L3697). Names are escaped with `esc`.
  - Today the source is the user's own storage, so this is self-XSS only.
  - Once snapshots or names come from a server or other players it becomes stored XSS.
  - Fix: validate saved data with a schema (zod) and escape or allow-list style values.
- **API keys:**
  - Today there is no key: the AI review uses the host's `window.claude.sample` (L3879).
  - Off the artifact host, an Anthropic API call must go through a server route with the key
    in server environment variables only.
  - It also needs a per-user rate limit and a monthly spend cap.
- **Third-party request:** Google Fonts loads from fonts.googleapis.com (L3–5). Self-host the
  fonts for privacy and for a strict CSP.

## 6. Mobile UX and accessibility

- **Cards have no accessible names.** `cardHTML` (L1548) renders the rank and suit glyphs in
  plain `div`s, so a screen reader reads raw glyphs. Each card needs an `aria-label` such as
  "Ace of spades".
- **Partial ARIA:** 18 `aria-label`s and two `aria-live="polite"` regions, the toast (L500)
  and the action feed (L505). That's a reasonable base.
- **Keyboard shortcuts** exist (for example `h` for hint, L3805). Focus order and visible
  focus are **not audited yet**.
- **Main-thread freezes hurt most on phones.** The emulated 4× slowdown numbers are in
  METRICS.md.
- **Not measured yet:** Lighthouse scores and real-device performance. No numbers are claimed
  for either.

## 7. Hiring manager (entry-level full-stack/backend/frontend)

**Strong signals:**
- A hard domain: five game variants, multi-part split pots, a 2-of-3 majority rule.
- Opponent modelling with range-based equity.
- A coach that explains its decisions.
- A real user group (the home game).

**What would make me pass today:**
- One untyped 3,900-line file with no tests or CI in the repo.
- It only runs inside claude.ai.
- No backend.
- No reproducible numbers.
- Unclear authorship of the code. Any line can come up in an interview, so you need to be
  able to explain each one.

**Highest-value additions, in order:**
1. Typed modules plus tests plus CI. This shows engineering discipline.
2. A measured performance fix with before/after numbers. This shows you can profile.
3. A server-authoritative multiplayer backend. This is the backend signal, and the only
   item that brings real users: the home game.
4. An LLM feature behind a server route with rate limits and evals. This shows you can
   integrate an LLM responsibly.

## 8. Technical interviewer: questions you should expect

- How does `pack()` order hands, and why does base 16 work? Each kicker is ≤ 14, so it fits
  in 4 bits, and category × 16⁵ dominates. Why 7,462 classes?
- Walk through `buildPots` with three all-ins of different sizes and a folder.
- Why Monte Carlo instead of exact enumeration for the coach? What is the standard error at
  N iterations?
- How do you test code that uses randomness?
- Why was the page freezing? How did you find out? What changed and by how much?
- How do you stop a client from seeing other players' cards? What happens on reconnect?
- How do you keep an LLM feature from leaking your key or running up a bill?
- What is a short all-in, and when does it reopen the betting?
