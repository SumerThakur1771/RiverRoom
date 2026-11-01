# Interview questions: server, security, database

Five questions to expect about the multiplayer server and its storage, with answers grounded
in this code. Numbers link to [METRICS.md](METRICS.md). Earlier questions (engine, equity,
the freeze fix) are in [ANALYSIS.md](ANALYSIS.md#8-technical-interviewer-questions-you-should-expect).

## 1. How do you guarantee a player never sees another player's hole cards?

- **Only the server has the deck.** It shuffles with Fisher-Yates and the platform CSPRNG
  (`crypto.getRandomValues`).
  - Each swap index comes from rejection sampling (`uniformInt` in `src/engine/rng.ts`), so
    every deck order is exactly equally likely, not just close.
  - Plain `x % n` would favour some cards by about 1 in 10⁸; the test suite shows that
    bias and fails if it comes back.
- **Each person gets their own copy.** After every engine step, `encodeGame` in
  `src/net/wire.ts` builds one copy of the game per person.
  - It is a whitelist: a field reaches a client only if it is listed there.
  - Another person's cards go as hidden placeholders, so the count is kept and the table
    can draw backs.
  - Their split, hand name, score and equity are left out until their cards are face up.
  - The deck and the computer players' private reasoning are never sent.
- **Waiting players are spectators.** Someone waiting to sit down sees the table as a
  spectator (viewer = -1), so they never see the cards of the computer player whose seat
  they are taking.
- **The tests check every message.**
  - `test/wire.test.ts` plays every game type with three people at one table and checks
    3,724 copies: 0 leaks.
  - `test/server.test.ts` checks every message on a live server against its real state:
    about 5,000 a run, 0 leaks.
  - Both tests have their own copy of the visibility rule. The first version reused the
    code's rule, so a broken rule also broke the check and the test still passed. I found
    that by breaking the rule on purpose.

## 2. Players reconnect with a session token, not a password. Why is that safe enough, and how is the token protected?

- **What a token unlocks.** One seat in one room, for one night.
  - It is 24 random bytes (192 bits) from `crypto.randomBytes`, so guessing is not
    realistic.
  - The server compares tokens with `timingSafeEqual`.
  - A new connection with the same token drops the old one: one live socket per seat.
- **How it is stored.** Only as a SHA-256 hash (`server/src/store.ts`), so a database leak
  gives no usable tokens. The storage test checks that no raw token is in the database.
- **Why SHA-256 and not bcrypt.** Slow hashes protect low-entropy secrets like passwords
  from guessing. A 192-bit random token can't be guessed, so a fast hash is fine and keeps
  lookups cheap.
- **Invite codes are not secrets.** They are 6 characters from a 32-letter alphabet,
  without 0/O/1/I, so friends can share them aloud. 256 is a multiple of 32, so
  `byte % 32` has no modulo bias.
- **Weak point.** The token lives in the browser's localStorage, so any XSS would expose it.
  - Player names are escaped before rendering.
  - A strict Content-Security-Policy header would be the next step.

## 3. What stops a client from abusing the server, or a visitor from running up the AI bill?

**Socket server (`server/src/server.ts`):**
- Every message is validated with zod.
- Messages are capped at 4 KB (`maxHttpBufferSize`).
- CORS allows only the app's origins.
- A per-socket token bucket allows 20 messages a second. A socket that floods is
  disconnected. The storage test once tripped this because the test client was too fast.
- Clients can only act for their own seat, on their own turn. The engine still enforces
  minimum raises and the short-all-in rule.
- A 30-second turn timer means a stalled client can't freeze the table.

**AI review route (`api/review.ts`):**
- The key (`OPENROUTER_API_KEY`) is only in a server environment variable.
- Free models are tried first. The paid model is a last resort, capped at 200 calls per UTC
  day.
- Reviews are cached by a SHA-256 of the prompt, in the browser and on the server, so the
  same hand does not call a model again. Identical requests in flight share one call.
- The prompt is compact: 1,683 characters per hand on average, down from 2,833. Output is
  capped at 500 tokens.
- Per-IP sliding windows allow 5 requests a minute and 20 an hour, plus 300 an hour per
  instance. Every answer is validated with zod.
- The eval can ask one model on its own, but only a free one. A paid model is refused, so
  that option can't run up the bill.
- **Limitation:** limits and caches live in memory, so each serverless instance counts on
  its own.
  - For a global limit I'd move the counters to Redis (for example Upstash) with the same
    sliding-window logic.
  - Until then, the hard global stop is the credit limit on the OpenRouter key.

## 4. The game never waits for the database. How do you keep the data correct?

- **Records, not writes.** The room emits records (buy-in, cash-out, finished hand, room
  closed), and `Store.record` chains them on one promise, so they are written in order.
  - Each hand and its per-seat results go in one nested Prisma create, so a hand is never
    half written.
  - A failed write is logged and counted. The storage test asserts 0 failures.
- **Trade-off.** Pending writes live in memory, so a crash can lose the last few records,
  but a slow database can never stall a hand.
  - If losing those records mattered more, I'd write each record to an outbox table in the
    same transaction as the game state, or run the engine step and the write together.
- **How it's checked** (`test/store.test.ts`, real Postgres, also in CI with a service
  container):
  - The settlement computed from Postgres equals the one from memory.
  - A player who left: their stored cash-out equals their buy-ins plus the sum of their
    stored per-hand results.

## 5. How do you settle up a night in the fewest payments?

- **The formula.** Each balance is cash-outs + chips on the table − buy-ins. The minimum
  number of payments is n − g:
  - n is the number of people with a nonzero balance;
  - g is the largest number of disjoint groups whose balances each sum to zero (a group of
    k people needs k − 1 payments).
- **Why it's hard, and why that's fine here.** Finding g is NP-hard in general. A home game
  is small, so `settle()` in `src/ledger/settle.ts` runs a bitmask DP over subsets,
  O(2ⁿ · n), for up to 16 people, then settles each group greedily.
  - Measured: 10.65 ms mean and 20.7 ms worst at 16 people.
  - Above 16 it falls back to greedy, which needs at most n − 1 payments.
- **Correctness.** A property test checks the result against a brute-force minimum on 400
  random cases.
- **Exact vs greedy.** On synthetic nights with 10 people, exact needed fewer payments than
  greedy on 170 of 200.
- **Computer players.** Chips won from or lost to bots show up as one "Computer players"
  balance. It is listed, but never paid.
