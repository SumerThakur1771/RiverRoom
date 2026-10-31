# River Room

[![CI](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/ci.yml/badge.svg)](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/ci.yml)
[![Live smoke test](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/live-smoke.yml/badge.svg)](https://github.com/SumerThakur1771/RiverRoom/actions/workflows/live-smoke.yml)

**Live:** https://sumer-riverroom.vercel.app

A poker trainer built around a real home game. You play No-Limit Hold'em and four
dealer's-choice "split" variants against computer players modelled on real friends, and a
coach explains each decision.

## What it does

- **Five games.** Hold'em, plus four split variants where each player divides their cards
  into parts (a poker hand plus one or two [3 Patti](https://en.wikipedia.org/wiki/Teen_patti)
  or 5-card hands) and each part wins its own share of the pot. In the 8-card game, winning
  2 of 3 parts takes the whole pot.
- **Full no-limit rules in the engine:** blinds and antes, minimum raises, short all-ins
  (including the TDA rule for several short all-ins that add up to a full raise), side pots,
  split pots and odd chips.
- **Two modes:** the home cash game (rebuys, cash-out sheet) and a sit-and-go tournament
  with rising blinds.
- **Play with friends** (`/mp.html`): invite-code tables on a Node + Socket.IO server that
  deals, runs the bots and sends each player only their own cards. Reconnects by session
  token; a turn timer keeps the game moving. **Settle up** shows everyone's buy-ins, rebuys
  and cash-outs and who pays whom, in the fewest possible payments.
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
- **AI hand review (optional):** after a hand, Claude (Haiku 5.5) writes a short review
  through a server route (`api/review.ts`). It needs `ANTHROPIC_API_KEY` set on the server.
  Without it, or when rate-limited, the built-in review is used.

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
server/       the multiplayer server (Node, Socket.IO), using the same engine, and its
              Postgres storage (server/src/store.ts).
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
npm run server:dev # multiplayer server on :8080 (open /mp.html from `npm run dev`)
```

Storage is optional. To try it locally with Postgres:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/riverroom
npm run db:migrate   # apply migrations (skipped when DATABASE_URL is unset)
npm run server:dev
```

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
- the browser smoke test and a two-browser multiplayer test;
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
