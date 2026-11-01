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

In live play the seed is null. The deck comes straight from the crypto RNG, and every other
segment uses a fast generator seeded from crypto.

**Deck shuffle.**
- *Live play* is exactly uniform: Fisher-Yates, where each position's swap index comes from
  `uniformInt(i + 1)`. That function uses rejection sampling on 32-bit crypto values, so
  every one of the 52! deck orders is equally likely.
  - Taking `x % n` alone is biased whenever n does not divide 2^32: the first `2^32 % n`
    results get one extra input each.
  - `uniformInt` discards the top `2^32 % n` inputs and draws again. At n = 52 that is 48
    of 2^32 values, so a redraw happens with probability 1.1e-8.
  - The old method was biased for 46 of the 51 sizes from 2 to 52, by up to 1.2e-8
    relative (n = 52).
- *Seeded play* keeps the original `% (i + 1)` shuffle, so recorded sessions and the 272
  golden hands still replay card for card.
- `test/shuffle.test.ts` checks this.
  - Exhaustive on an 8-bit source: for every n up to 52, each result gets the same number
    of inputs, and exactly `range % n` inputs are rejected. Putting plain `% n` back fails
    these tests.
  - Chi-square tests on 208,000 crypto draws, and on the top and bottom card of 52,000 live
    shuffles. The threshold is set so a correct shuffle fails about once in a million runs.

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

## 7. Keeping the page responsive: the compute worker (`src/worker`, `src/coach/compute.ts`)

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
runnable in a Web Worker and in Node. The screen code is covered in section 13.

## 9. AI hand review (`api/review.ts`, `src/review`)

After a hand, "Ask the AI coach" sends the hand history and the app's own read of each
decision to `POST /api/review`, a Vercel serverless function. The function asks models on
OpenRouter, free models first. The design aims at the lowest cost, and the player always gets
a review.

**Models (`src/review/openrouter.ts`).** OpenRouter's OpenAI-compatible chat completions API
is called with plain `fetch`; there is no SDK. The chain:
1. `google/gemma-4-26b-a4b-it:free`: free.
2. `nvidia/nemotron-3.5-super-vl:free`: free, and from a different provider than the first,
   so one provider's outage or rate limit does not take out both free options.
   - The original choice, `openai/gpt-oss-20b:free`, no longer exists on OpenRouter; only
     paid gpt-oss variants are listed.
   - In the live eval (METRICS.md), Google's free Gemma models were rate-limited on every
     request, while Nemotron answered all 20 hands. That is exactly the case the second
     provider is for.
   - It also beat `google/gemma-4-31b-it:free`, which could not answer at all.
3. `google/gemini-2.5-flash-lite`: paid ($0.10 / $0.40 per million input / output tokens),
   used only when both free models fail.

The chain moves to the next model after any of these:
- an HTTP error, or a rate limit (429, or an error inside the stream);
- no complete answer within 20 s;
- a cut-off (`length`) or filtered answer;
- an answer that is not valid JSON matching the zod schema.

**JSON.** Every model is asked for the strongest JSON mode it supports:
- `response_format` `json_schema` (strict) where the model has structured outputs;
- `json_object` where it has only JSON mode (the Gemmas);
- the prompt itself always says "only this JSON object".

Every answer is validated with zod (`grade`, `mistake`, `lesson`) whatever mode was used.
`tools/review/check-models.ts` reads OpenRouter's public model list in CI and fails if:
- a model has disappeared;
- a "free" model has a price;
- a model is sent a JSON mode it does not support.

That check is how the missing gpt-oss model was found.

**Cost controls.**
- *Compact prompt* (`src/review/prompt.ts`). The 486-character system prompt and the hand go
  out without seat headers, table chat, the practice-view dump of folded players' cards and
  the summary. Each decision becomes one short line. That cut the prompt from 2,833 to 1,683
  characters per hand on the eval set.
- *Output cap.* `max_tokens` is 500 and temperature 0.2. A reasoning model (Nemotron) gets
  an 800-token thinking budget on top, with the reasoning left out of the reply.
  - With 500 tokens in total, Nemotron was cut off on all 20 eval hands.
  - With the budget, it gave 20 valid answers.
  - Only free models reason here, so the budget costs nothing.
- *Caching.* The cache key is a SHA-256 of the prompt version plus the exact prompt text
  (`src/review/key.ts`). The browser and the server compute it the same way.
  - The browser keeps up to 100 reviews in localStorage, so reopening a reviewed hand makes
    no request at all.
  - The server keeps up to 500 in memory, and two requests for the same hand at the same
    time share one model call.
  - A cache hit does not count against the rate limit.
- *Limits* (`src/review/rate-limit.ts`):
  - per IP: 5 a minute and 20 an hour;
  - 300 an hour per instance;
  - at most 200 paid-model calls per UTC day. After that the chain stops at the free models
    and falls back to the built-in review.

**Streaming and fallbacks.** The function streams server-sent events:
- `attempt`: which model is being asked;
- `delta`: its output as it arrives;
- `result`: the validated review, with the model, free or paid, and the list of attempts;
- `fallback`: no model gave a valid answer.

The page shows the model's name in small text under the review. The built-in review stands
whenever the AI review fails:
- no key (503);
- rate limited (429);
- bad request (400);
- today's paid cap used up;
- every model failed;
- offline.

**Logging.** One JSON line per review in the function logs, with:
- which model answered, and whether it was free or paid;
- every attempt and how it ended;
- token usage and cost as OpenRouter reports them;
- paid calls used today.

**Security.**
- The key is read from `process.env.OPENROUTER_API_KEY` on the server only.
- The request body is validated (size and shape) before any model call.
- The eval may ask one model on its own, but only one of the free candidates. A paid or
  unknown model is refused, so the option cannot be used to run up the bill.

**Tradeoff: the limits and caches live in memory, so they hold per Vercel instance, not
globally.** A global limit needs a shared store (Redis), which would be another hosted
service. The hard global stop is the credit limit on the OpenRouter key itself.

**Eval.** `test/review-eval/hands.json` holds 20 hands generated by the simulator:
- 10 where the app's coach found a mistake, and 10 played well;
- across home Hold'em, tournaments, Poker + 3 Patti and Two boards.

`tools/review/eval.ts` scores answers on four checks:
- the answer is schema-valid;
- the grade is within one step of the coach's;
- a mistake is reported if and only if the coach found one;
- the mistake's street is named.

The reference is the app's own coach, so the score measures agreement with it, not poker
truth. It also reports which model answered each hand, the free vs paid split, and each
model's attempt outcomes and latency.

CI runs it against mock models:
- a perfect mock;
- a lazy mock (to show the scorer separates good answers from bad ones);
- a mock chain where the free models fail on some hands, to exercise the fall-through.

The live run is manual (the "AI review eval (live)" workflow). It runs each free candidate
on its own, then the real chain, against the deployed endpoint.

## 10. Multiplayer: a server-authoritative table (`server/`)

**What it does.** Friends play the home game online:
- One player starts a table and gets a 6-character invite code (no 0/O/1/I).
- Others join with the code and their name; computer players hold the empty seats.
- Each human gets a session token, kept in the browser's local storage, so a reload or a
  dropped connection puts them back in their seat.

**Server-authoritative.**
- The Node server (Socket.IO) runs the same engine generator as the browser game.
- It shuffles with the crypto RNG and decides every bot move.
- It is the only place hole cards exist. After every engine step it builds a view for each
  seat (`server/src/view.ts`) with public information plus that seat's own cards. Other
  players' cards appear only once they are turned face up (showdown or an all-in runout).
  Someone who joins mid-hand watches as a spectator until the next deal, so they never see
  the cards of the bot whose seat they are taking.
- Clients can send only `act`, `rebuy` and `leave` for their own seat, on their own turn. Each
  message is validated with zod.
- The engine still enforces the betting rules (minimum raise, short all-ins).
- Each socket may send 20 messages a second.
- A turn timer (30 s) checks or folds for anyone who doesn't act, so a disconnected player
  never stalls the table.

**Testing it.** `test/server.test.ts` starts a real server and three real Socket.IO clients
that play full hands against two bots. A hook compares every outgoing view with the
server's real state at that moment. In 5 runs it checked 1,312 to 1,445 views over 12 hands
with 0 leaks, and a deliberately broken visibility rule makes it fail. The test also covers:
- a player who stops acting (the timer folds or checks for them);
- a disconnect and a reconnect by token (same seat, same cards);
- a wrong token being refused;
- invalid input.

`tools/ui/mp-smoke.mjs` plays two browsers against the bundled server in CI.

One false alarm, and what it taught: the leak check once flagged a player who was waiting for
a seat. They were shown the cards of the bot in that seat, but only after those cards had
been turned face up for everyone. The check had treated "the seat you will take" as "your
own cards". It now applies the public rule to anyone not yet seated, and putting the
original bug back (waiting players see their future seat's cards) still fails it 3 runs out
of 3.

**Getting there, and leaving.**
- The single-player start screen has a "Play online with friends" button. The installed app
  also has it as an icon shortcut.
- An invite link (`/mp.html?code=ABC234`) opens a join view with the code filled in.
- `tools/ui/mp-entry.mjs` checks the whole path on desktop and phone, in CI and on
  production: start screen, then start a table, then the invite link, then join, then both
  players are seated.

**Losing a seat.** A player who runs out of chips and does not answer the rebuy question
within 30 s loses the seat to a computer player.
- The server now tells them (`removed` event), and their page returns to the lobby with the
  reason. Before, the page kept showing a table it no longer received.
- The entry test found this: its host busted and sat on "Waiting for the next hand"
  forever.
- The replacement computer player never copies a name already at the table. Before, when
  all four friends were seated, the seat went to a second "Rohit".

**Tradeoffs.**
- Game state lives in the server's memory (the engine generator cannot be serialized), so a
  restart ends the current hand. Rooms, buy-ins and hand histories go to the database.
- Showdown: humans always show their cards (as in the single-player game), with no option
  to muck.
- One server instance. Several instances would need sticky sessions or a shared room
  registry.

## 11. Storage and settling up (`prisma/`, `server/src/store.ts`, `src/ledger/settle.ts`)

**What is stored.** With `DATABASE_URL` set, the server writes to Postgres through Prisma
(`prisma/schema.prisma`):
- `Room`: invite code, when it opened and closed.
- `Player`: display name and a SHA-256 hash of the session token. The token itself is never
  stored, so a database leak does not let anyone take over a seat.
- `Hand` and `HandResult`: every finished hand's public log (the "Dealt to" lines with private
  cards are left out) and each seat's net result. Bots have no player row.
- `LedgerEntry`: every buy-in, rebuy and cash-out, in cents.

**How it writes.** The game never waits for the database. The room emits records (buy-in,
cash-out, hand, close) and `Store` applies them through one promise chain, so they land in
order. A failed write is logged and counted, and play goes on. The room also keeps the same
ledger in memory, so "Settle up" works without a database. The integration test checks that
both give the same answer.

**Settling up.** Each person's balance is cash-outs + chips on the table − buy-ins. The
fewest payments that clear every balance equals n − g:
- n is the number of people with a nonzero balance;
- g is the largest number of groups the people can be split into so that each group's
  balances add up to zero (a group of k people needs k − 1 payments).

Finding g is a set-partition problem, which is NP-hard in general. A home game is small, so
`settle()` runs a dynamic program over subsets (bitmask, O(2^n · n)) for up to 16 people. It
then settles each group largest-debtor-to-largest-creditor. Above 16 people it uses that
greedy method on everyone (at most n − 1 payments). A property test compares `settle()`
with a brute-force minimum on 400 random nights.

Chips won from or lost to the computer players mean the humans' balances don't add up to
zero. That difference becomes a "Computer players" balance. The settle-up screen lists it,
but nobody pays it or gets paid by it.

**Hosting (free tiers).** The game server is a Render free web service (`render.yaml`), and
Postgres is on Neon's free plan.
- Render builds with dev dependencies (esbuild bundles the server, Prisma generates its
  client).
- Render's free instances have no pre-deploy step, so the start command is
  `npm run db:migrate && npm run server:start`. Migrations run just before the server
  starts; if they fail, the new version never goes live, and the health check on `/health`
  keeps the old one.
- Neon gives two connection strings. The server uses the pooled one (`DATABASE_URL`, host
  with `-pooler`), which is PgBouncer in transaction mode and suits many short queries.
  `prisma migrate` takes session-level locks that a transaction-mode pooler cannot hold, so
  migrations use the direct one (`DIRECT_DATABASE_URL`, read by `prisma.config.ts`).
- I checked this locally: with the pooled URL pointing nowhere and the direct one valid,
  migrations still applied.
- Render free services sleep after 15 minutes without traffic and take about a minute to
  wake. While the first connection is pending, the multiplayer page says "Waking up the
  server, about a minute", and a "Start a table" click waits for the server instead of
  failing. `tools/ui/mp-wake.mjs` tests this in CI against a server that starts 8 s late.
- A sleeping server also ends any game in memory. Rooms already close after 15 idle
  minutes, and buy-ins, hands and settlements are in Postgres.

CI runs the storage test and the two-browser test against a Postgres 16 service
container.

**Tradeoffs.**
- Each hand and its results are one nested Prisma create, so a hand is never half written.
  But the queue of pending writes lives in memory, so a crash can lose the last few records.
  In exchange, the database can never block or slow the game.
- Hand logs are stored as text, not as structured actions. That is enough for history and
  disputes; replaying hands would need the action list.
- A player's identity is per room (token hash). There are no accounts, by design.

## 12. Installable, offline, accessible (`src/pwa`, `vite.config.ts`, `public/`)

**Installable app.** `public/manifest.webmanifest` gives the name, colors and icons. The PNG
icons, including a maskable one, are rendered from one SVG by `tools/pwa/make-icons.mjs`.

**Offline single-player.** `src/pwa/sw.js` is a hand-written service worker, about 60 lines,
with no Workbox.
- A small Vite plugin in `vite.config.ts` writes it into the build. The plugin prepends the
  list of files to cache (every built file plus `public/`) and a version: a hash of the
  contents of all those files.
- Any change to any file, even an HTML page whose name never changes, gives a new version. A
  new version installs a fresh cache and deletes the old one.
- Pages are fetched network-first (fresh when online, cached when offline).
- Hashed assets are served cache-first, since their names change with their content.
- Google Fonts are cached on first use.
- `/api/` (the AI review), `/_vercel/` (analytics) and the multiplayer server are never
  cached.

Offline, the game runs entirely in the browser: engine, bots and the coach's worker. "Ask
Claude" says it needs a connection, and the built-in review still works.
`tools/ui/offline.mjs` checks all of this in CI: it loads once, cuts the network, reloads
and plays hands.

**Accessibility.** Lighthouse audits each page as first loaded, which for the game means
the start screen. So `tools/ui/axe-table.mjs` also runs axe-core, the engine Lighthouse uses,
on the table mid-hand, the hint panel and the end-of-hand review, on desktop and phone.

That found one issue Lighthouse missed: on phones the hint panel scrolled but could not be
reached by keyboard. It is now a focusable region. Lighthouse also flagged one contrast
issue, small captions at 4.32:1, now above 4.5:1. CI fails if the Lighthouse accessibility
score drops below 95 or axe finds any WCAG 2.1 A/AA violation.

**Analytics.** Vercel Web Analytics is set up through `@vercel/analytics`, with no cookies.
It is skipped on localhost. Query strings are removed before anything is sent, because the
multiplayer page's `?code=` is a private invite code. Data appears once Web Analytics is
turned on in the Vercel project.

## 13. Typing the screen code (`src/ui`, `tsconfig.ui.json`)

The screens (`src/ui/legacy.js`, 1,576 lines of DOM code by `wc -l`) are still JavaScript. They
are now type-checked by TypeScript with `checkJs`, in non-strict mode, and
`npm run typecheck` (so CI) fails on any error. Converting them to strict TypeScript would
mean about 789 errors, measured with `checkJs` and `strict: true`. 615 of those are only
"implicitly any". That was out of scope for the time given.

**What the checker found, and what changed:**
- 94 errors at first. Most came from browser globals it did not know (the artifact host's
  `window.claude`, the measurement hooks, `webkitAudioContext`). These are now declared in
  `src/ui/globals.d.ts`.
- One fragile spot: an async block read `resumeSnap` before its `let` line. It only worked
  because the read came after several `await`s. The declaration now comes first.
- The DOM elements the screens attach to engine players (`p.el`, `p.betEl`) are declared by
  module augmentation in the UI's declarations, so the engine's own `Player` type stays
  DOM-free.
- Typing the game-state variable `S` as the engine's game type uncovered more spots,
  which are now annotated with JSDoc. Event payloads are free-form by design (`unknown` in
  the engine); the two functions that format them read them through one `any` alias.

**The worker client is strict TypeScript** (`src/ui/compute-client.ts`). Each job kind now
has a result type (`JobResults` in `src/coach/compute.ts`), so `compute({ type: 'bot', … })`
resolves to `{ action, patch }`, not `unknown`.
