# River Room: design notes

How the main parts work, why they are built this way, and what I would change with more
time. Numbers quoted here come from [METRICS.md](METRICS.md).

## 1. The engine is a generator (`src/engine/engine.ts`)

**What it does.** Deals, takes blinds and antes, runs the betting rounds, builds side pots
and pays the showdown, for Hold'em and the four split variants.

**Key idea.** `playHand(g)` is a generator function. It runs the rules until it needs
something it cannot decide itself, then `yield`s a request:

```
{ kind: 'act', p }          a player must act         -> answer: { type: 'raise', to: 120 }
{ kind: 'variant', p }      the dealer picks the game -> answer: 'k8'
{ kind: 'split', p, k }     final split at showdown   -> answer: [[..2 cards..], [..3..], [..3..]]
{ kind: 'pause', what }     a moment the UI may animate (cards dealt, chips moved, pot paid)
```

Whoever drives the generator answers with `gen.next(answer)`:
- the browser animates the pauses and waits for a tap on the hero's turn;
- the simulator and tests answer instantly with bots or scripts.

The same rules code runs in the browser, in Node and in a Web Worker.

**Why.** In the original, the rules were `async` functions that awaited animations
(`await betFly(p)` inside `applyAction`), so nothing could run without a DOM. Rewriting the
flow as an explicit state machine would have meant restructuring about 600 lines of
control flow. A generator keeps the original's structure almost line for line (`await` →
`yield`), which made an exact port feasible.

**Tradeoffs.**
- Generator state cannot be serialized. A hand in progress cannot be saved mid-way, only
  between hands; the original had the same limit.
- For a multiplayer server, an in-memory generator per table is fine, but a server restart
  loses the current hand.

**With more time.** An explicit reducer `(state, action) -> state` would allow mid-hand
persistence and time-travel debugging.

## 2. Proving the port: golden traces (`tools/golden/record.mjs`, `test/golden.test.ts`)

**What it does.** Records seeded sessions of the original single-file game in headless
Chromium: per hand the deck order, every action as submitted, the final splits, the full
hand-history log and everyone's stack afterwards. The test replays each hand through the
new engine with the same inputs and requires identical log lines and stacks.

**Why this design.** Comparing whole sessions would also compare the bots, whose randomness
is hard to align exactly. Feeding the recorded decisions back in tests only the rules:
dealing, betting, pots, showdown and winners.

The bots are checked separately and statistically (section 6).

**Result.** All 272 recorded hands match (35 with side pots, 104 all-ins, 74 two-of-three
majority wins). Antes never came up in the recordings, so they have their own unit test.

## 3. Randomness: named, seeded streams (`src/engine/rng.ts`)

Every random decision runs inside a named segment, for example `h12:ai:3` (the 4th bot
decision of hand 12). Each segment gets its own generator (mulberry32) seeded by
`hash(tableSeed + '|' + label)`.

**Why.**
- A whole session replays from one seed string (`?seed=...` in the URL).
- Cosmetic randomness (chat lines, sounds) can never shift a card or a decision.
- A computation can move between threads, or to later in time, and still draw exactly the
  same numbers. The Web Worker relies on this (section 7).

In live play the seed is null and every segment uses the browser's crypto RNG.

**Deck shuffle.** Fisher-Yates over 32-bit values with `% (i + 1)`, as in the original.
The modulo bias is at most about 1.2e-8 per draw. A real-money server should use
rejection sampling.

## 4. Hand evaluation (`src/engine/cards.ts`, `src/engine/teenpatti.ts`)

**Packing.** A hand's value is `category * 16^5 + k0 * 16^4 + ... + k4`:
- the category runs 0 (high card) to 8 (straight flush);
- k0..k4 are the ranks that break ties (kickers), most important first.

Every rank is at most 14, so each fits in 4 bits. Comparing two hands is then one numeric
comparison.

**Algorithm.** One pass counts ranks and suits into small arrays and a bitmask of ranks
present. Straights are found by sliding a 5-bit window over the mask (the ace is also set
as rank 1 for the wheel). Then the categories are checked from best to worst.

**Verified.** All 2,598,960 five-card hands fall into the standard category counts, with
exactly 7,462 distinct values (the known number of 5-card equivalence classes). On 20,000
random 7-card hands, the result equals the brute-force maximum over all 21 five-card
subsets. 3 Patti: all 22,100 three-card hands match the standard counts.

**Speed.** About 2.2 million 5-card and 1.6–1.9 million 7-card hands per second in Node.
That is not the bottleneck (section 7), so a lookup-table evaluator was not worth building.

## 5. Equity by range-based Monte Carlo (`src/ai/equity.ts`, `src/ai/split.ts`)

**What it does.** Estimates your chance of winning:
1. Sample hands for each opponent that fit what their actions suggest. Each opponent's
   actions shrink a "range model": raising preflop narrows them to stronger starting hands,
   a big river bet from a tight player means two pair or better, and so on.
2. Deal out the rest of the board.
3. Count wins and ties.

Split games play the whole hand out: every player splits sensibly, each part is scored,
and the house rules (half each, or 2 of 3 parts takes the pot) decide the share.

**Why Monte Carlo and not exact enumeration?** With several opponents holding ranges, exact
enumeration explodes. A few hundred samples give a standard error of about 2–3 percentage
points, enough for a coach's advice.

Exact enumeration is used where it is cheap: in tests (AA vs KK over all 1,712,304 boards
gives 81.255%) and for the last card in face-up all-ins.

## 6. Bots and statistical parity (`src/ai/bots.ts`, `tools/sim/parity.ts`)

The bots are a line-by-line port. They are checked statistically, not hand by hand:
- the original game and the port play the same session plan with the same scripted hero;
- each persona's VPIP, PFR and postflop aggression frequency must be within 3 standard
  errors of the original's.

All 16 persona/game rows pass. METRICS.md lists the borderline ones, and why the
tournament samples can only rule out large changes.

## 7. Keeping the page responsive: the compute worker (`src/worker`, `src/coach/compute.js`)

**Problem (measured).** In the original:
- The split-game opponent model (`oppDist`) took about 0.6–0.75 s on the main thread for
  each variant, a few seconds after the page loaded.
- The coach analysed every hero turn, even with no hint open: 296 ms median in the 8-card
  game, about 2 s with a 4× CPU slowdown.
- Bot decisions blocked for 64 ms median in the 8-card game.

**Fix.**
- **Tables in the worker.** The worker builds the opponent-model tables once per table and
  hands copies to the page (`Tables.adopt`), so the page never builds them.
- **Bots in the worker.** On a bot's turn the page sends a plain snapshot of the game
  (`toPlain`, about the size of a few KB of JSON). The worker returns the action plus the
  few fields the bot updates on itself. The bot's "thinking time" animation overlaps with
  this work.
- **Lazy coach.** On your turn the page computes only what the buttons need (pot odds and
  your seat). The full analysis runs in the worker only when you open a hint, and, for
  grading, at the end of the hand. The page keeps two snapshots per decision: before the
  action (for the analysis) and after it (for the recommendation and grade, as the original
  computed them then). Because each step runs on its own named seeded stream, the late
  grade equals the grade at the time. `test/coach-lazy.test.ts` checks this on 98 decisions
  across all five games.
- **Fallback.** If a browser cannot start the worker, the same functions run on the page.

**Tradeoffs.** Each bot decision copies the game state to the worker (structured clone,
small). The end-of-hand review appears a fraction of a second later while the grades are
computed.

## 8. The coach in strict TypeScript (`src/coach`)

The coach was carried over from the original as plain JavaScript, then typed under `strict`:
- `CoachCtx`: the coach's read of a decision.
- `Rec`: its recommendation.
- `Grade`: the grade of what you did.

Function bodies were kept as they were, so the grades could not drift. The 98-decision
eager-vs-lazy test passes before and after. ESLint forbids `window`, `document`,
`localStorage` and `location` in the engine, bots, coach and worker, which keeps them
runnable in a Web Worker and in Node. The screen code (`src/ui`) is still plain JavaScript.

## 9. AI hand review (`api/review.ts`, `src/review`)

After a hand, "Ask Claude" sends the hand history and the app's own read of each decision to
`POST /api/review`, a Vercel serverless function.

**Model and output.**
- It calls Claude Haiku 5.5 (`claude-haiku-5-5`, small and fast), with effort `low`.
- The response format is constrained to a zod schema `{grade, mistake, lesson}`.
- The reply streams back as server-sent events (`delta` while it is generated, then `result`).
- The final JSON is validated with zod again on the server before it is shown.

**Fallbacks.** The player always gets a review: anything other than a valid result means the
app's built-in review stands. That covers:
- no API key (503);
- rate limited (429);
- bad request (400);
- a refusal, a cut-off answer, invalid JSON or the wrong shape (a `fallback` event).

**Security.**
- The key is read from `process.env.ANTHROPIC_API_KEY` on the server only.
- The request body is validated (size and shape) before any model call.
- Limits per IP: 5 requests a minute and 20 an hour. Each server instance also caps itself at
  300 an hour, as a spend guard.

**Tradeoff: the limiter is in memory, so it holds per Vercel instance, not globally.** A
global limit needs a shared store (Redis), which would be another hosted service. The
per-instance cap still bounds spend per instance.

**Eval.** `test/review-eval/hands.json` holds 20 hands generated by the simulator:
- 10 where the app's coach found a mistake, and 10 played well;
- across home Hold'em, tournaments, Poker + 3 Patti and Two boards.

`tools/review/eval.ts` scores answers on four checks: schema-valid, grade within one step of
the coach's, mistake reported if and only if the coach found one, and the mistake's street
named. The reference is the app's own coach, so the score measures agreement with it, not
poker truth.

In CI it runs against a mock model, which checks the scoring pipeline only. Against the real
model it runs from the "AI review eval (live)" workflow, through the deployed endpoint.

## 10. Not built yet: server-authoritative multiplayer (Tier 2 plan)

Today every card lives in the browser, which is fine for a single-player trainer. For real
games with friends:
- the server would own the deck (crypto RNG with rejection sampling) and run this same
  engine;
- it would validate every action (the engine already enforces minimum raises and the
  short-all-in rule);
- it would send each player only public state plus their own cards.

The generator design (section 1) maps directly onto that: the server drives the generator
and answers `act` requests with moves received over a socket.
