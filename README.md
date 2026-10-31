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
  token; a turn timer keeps the game moving.
- **Bots** with distinct styles (tight folder, bluffer, strong all-rounder, wild card, and
  eight generic types). They estimate their chances by Monte Carlo simulation against
  what your actions suggest you hold.
- **Coach:** a hint on demand during a hand, a grade for each decision, and a hand review.
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
              by the engine; still plain JavaScript).
server/       the multiplayer server (Node, Socket.IO), using the same engine.
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

## Test it

```bash
npm run typecheck
npm run lint
npm test           # unit tests and the golden replay
npm run smoke      # clicks through hands in Chromium (needs `npm run dev` running)
npm run parity     # bot statistics vs the original game (about 2 minutes)
```

CI runs typecheck, lint, the tests with coverage, the build and the browser smoke test on
every push. After each production deploy, the smoke test also runs against the live site.

## Measurements

Every number about this project (speed, freezes, test results, bot statistics) is in
[METRICS.md](METRICS.md), each with the command that produced it.

## Project documents

- [ANALYSIS.md](ANALYSIS.md): audit of the original version.
- [PLAN.md](PLAN.md): the roadmap and what changed along the way.
- [DESIGN.md](DESIGN.md): how the engine, randomness, evaluator, equity, bots and the worker work, with tradeoffs.
