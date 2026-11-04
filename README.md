# River Room

[![CI](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/ci.yml/badge.svg)](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/ci.yml)
[![Live smoke test](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/live-smoke.yml/badge.svg)](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/live-smoke.yml)

**Live:** https://sumer-riverroom.vercel.app · **Play online with friends:** https://sumer-riverroom.vercel.app/?online

A poker trainer built around a real home game. You play No-Limit Hold'em and four
dealer's-choice "split" variants against computer players modelled on real friends, and a
coach explains each decision.

## What it does

- **Five games.** Hold'em, plus four split variants where each player divides their cards
  into parts (a poker hand plus one or two [3 Patti](https://en.wikipedia.org/wiki/Teen_patti)
  or 5-card hands) and each part wins its own share of the pot. In the 8-card game, winning
  2 of 3 parts takes the whole pot. A setting picks the 3 Patti A-2-3 rule: second-best
  sequence (standard) or lowest (a common home-game house rule).
- **Full no-limit rules in the engine:** blinds and antes, minimum raises, short all-ins
  (including the TDA rule for several short all-ins that add up to a full raise), side pots,
  split pots and odd chips.
- **Two modes:** the home cash game (rebuys, cash-out sheet) and a sit-and-go tournament
  with rising blinds.
- **Pick who you are:** the home game's roster is Sumer and his four friends. Play as any
  of them, rename them, add up to six players or trim to two; the computer plays everyone
  you don't, each in their own style (Sumer's computer style is "Balanced").
- **Play online with friends** (the start screen's "Play online with friends" button; also a
  shortcut on the installed app's icon). It is the same table, with dealer's choice, splits,
  the coach and hand history:
  - open a table and you land in a **waiting room** with the table code to share; choose
    how many computers play (none is fine) and the turn timer (off, 15, 30 or 60 s), and
    press Start when everyone is in;
  - friends tap **Join with a code** (or open the invite link) and pick a free player or
    create their own; a picked player stays locked to them;
  - the server deals and sends each person only their own cards;
  - the person who started the table manages the players and settings; friends who join
    later sit down between hands;
  - you always sit at the bottom of your own screen, as in any poker app, and the cards you
    arrange stay in your order;
  - reloading or a dropped connection puts you back in your seat (each tab has its own);
  - **Settle up** shows who pays whom, in the fewest payments.
- **Saved games (optional):** with `DATABASE_URL` set, the server stores rooms, players,
  hand histories and the buy-in ledger in Postgres (Prisma). Session tokens are stored only
  as hashes.
- **Bots** with distinct styles (tight folder, bluffer, strong all-rounder, wild card, and
  eight generic types). They estimate their chances by Monte Carlo simulation against
  what your actions suggest you hold.
- **Coach:** a hint on demand during a hand, a grade for each decision, and a hand review.
- **Installable, works offline:** add it to your home screen; single-player (engine, bots,
  coach) runs with no network, cached by a hand-written service worker.
- **Accessible:** Lighthouse accessibility 100 on both pages (local build), and no axe-core
  WCAG 2.1 A/AA violations on the in-game screens. Both are checked in CI.
- **AI hand review (optional):** after a hand, "Ask the AI coach" gets a short review
  (grade, biggest mistake, one lesson) from a server route (`api/review.ts`) that calls
  OpenRouter: two free models first, a cheap paid one as a last resort. It is capped at 200
  paid calls a day, and reviews are cached in the browser and on the server, so reopening a
  reviewed hand does not call a model again. It needs
  `OPENROUTER_API_KEY` on the server; without it, or when limits are hit, the app's own coach
  review is shown.

## How it is built

```
src/engine/   rules and game state: cards, hand evaluation, variants, betting, pots,
              showdowns. No DOM. The hand flow is a generator that pauses whenever it
              needs a decision, so the browser, a simulator and tests drive the same code.
src/ai/       equity estimates, split-game valuation, and the bots.
src/sim/      headless driver for simulations and tests.
src/coach/    the coach and the shared helpers, strict TypeScript and DOM-free: runs on the
              page, in the worker and in Node tests.
src/worker/   the compute Web Worker: bots, coach analysis and opponent-model tables run
              here so the page never freezes.
src/ui/       screens and animations (carried over from the original version and driven
              by the engine). JavaScript, type-checked by TypeScript (checkJs, not strict);
              the worker client is strict TypeScript.
server/       the online-play server (Node, Socket.IO), using the same engine, and its
              Postgres storage (server/src/store.ts).
src/net/      the online wire format: each person's redacted copy of the game (anti-cheat).
src/pwa/      service worker and page setup (offline cache, analytics).
src/ledger/   end-of-night settlement: fewest payments, exact for up to 16 people.
prisma/       database schema and migrations.
api/          Vercel serverless routes (the AI hand review).
legacy/       the original single-file version, kept as the reference until parity.
tools/        recorders, measurement scripts and the browser smoke test.
```

The engine was ported from the original single-file game. To prove the port is faithful,
`tools/golden/record.mjs` plays seeded sessions of the original in a headless browser and
records each hand's deck, actions and outcome. `test/golden.test.ts` replays all of them
through the new engine and requires identical hand histories and chip counts.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (add ?seed=anything for a reproducible session)
npm run build      # production build in dist/
npm run server:dev # online-play server on :8080 (then "Play online with friends" in `npm run dev`)
```

Storage is optional. To try it locally with Postgres:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/riverroom
npm run db:migrate   # apply migrations (skipped when DATABASE_URL is unset)
npm run server:dev
```

## Deploy it (free tiers)

- **Web app and AI review:** Vercel. Set `OPENROUTER_API_KEY` (server only) and
  `VITE_MP_SERVER_URL` (the game server's URL).
- **Game server:** a Render free web service from `render.yaml` (Blueprint). It sleeps
  when idle; the page says "waking up the server" for the first minute.
- **Database:** Neon free Postgres. On Render, set `DATABASE_URL` to Neon's pooled
  connection string and `DIRECT_DATABASE_URL` to the direct one (used for migrations).

## Test it

```bash
npm run typecheck
npm run lint
npm test           # unit tests, golden replay, server tests (storage test needs TEST_DATABASE_URL)
npm run smoke      # clicks through hands in Chromium (needs `npm run dev` running)
npm run parity     # bot statistics vs the original game (about 2 minutes)
```

CI runs on every push:
- typecheck and lint;
- the tests with coverage, including storage tests against a Postgres service container;
- the build;
- the browser smoke test and a three-browser multiplayer test (waiting room, joining by code);
- an offline-play test;
- axe-core on the in-game screens;
- Lighthouse, which fails the build below 95 accessibility.

After each production deploy, the smoke test and Lighthouse also run against the live site.

## Measurements

Every number about this project (speed, freezes, test results, bot statistics) is in
[METRICS.md](METRICS.md), each with the command that produced it.

## Project documents

- [ANALYSIS.md](ANALYSIS.md): audit of the original version.
- [PLAN.md](PLAN.md): the roadmap and what changed along the way.
- [INTERVIEW_QUESTIONS.md](INTERVIEW_QUESTIONS.md): questions to expect about the server, security and the database, with answers.
- [DESIGN.md](DESIGN.md): how the engine, randomness, evaluator, equity, bots, the worker, the AI review, the multiplayer server and storage work, with tradeoffs.
