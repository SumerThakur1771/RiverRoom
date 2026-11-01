// The online wire format is the anti-cheat boundary. Real hands, every game type, three people
// at one table: at every step, each person's copy (and a spectator's) must hold nobody else's
// hidden cards or hand details, never the deck or the computer players' private reasoning, and
// must decode back into a game whose player references work.
import { describe, expect, it } from 'vitest';
import { botAction, botFinalSplit, initPlans, pickVariantFor, practiceSplits } from '../src/ai/bots';
import { planSplit } from '../src/ai/split';
import { newGame, playHand, type Step } from '../src/engine/engine';
import { DEFAULT_ROSTER } from '../src/engine/roster';
import type { Game } from '../src/engine/state';
import type { VariantKey } from '../src/engine/variants';
import { decodeGame, decodeStep, encodeGame, encodeStep, HIDDEN, type WireGame } from '../src/net/wire';
import type { Player } from '../src/engine/state';

/** The rule, written out here independently of the code under test: your own cards, or cards shown at the showdown. */
const canSee = (p: Player, viewer: number): boolean => p.i === viewer || (p.shown && !p.folded && !p.mucked);
import { scriptedHero } from '../src/sim/driver';

const SETTINGS = { name: '', opp: 4, stack: 1000, perLevel: 10, revealAll: false, games: 'dealer' as const };
const PRIVATE_KEYS = ['parts', 'extra', 'plan', 'handName', 'pname', 'pscore', 'score', 'eq', 'eqAtReveal', 'vrank'];
const NEVER = ['deck', 'nextDeck', 'persona', 'hf', 'rg', 'tilt', 'mem', '_plan', '_eq', 'stats', 'btab'];

function threePeople(seed: string): Game {
  const g = newGame({ mode: 'home', seed, settings: SETTINGS, roster: DEFAULT_ROSTER, heroId: 'sumer' });
  // two more people take two of the computer's seats (as the server does when they join)
  for (const p of g.players.slice(1, 3)) { p.isHuman = true; p.type = null; p.persona = null; }
  return g;
}
const keysDeep = (v: unknown, out = new Set<string>()): Set<string> => {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

function check(g: Game, viewer: number, w: WireGame, problems: string[]): void {
  const json = JSON.parse(JSON.stringify(w)) as WireGame; // what actually crosses the wire
  for (const k of NEVER) if (keysDeep(json).has(k)) problems.push(`viewer ${viewer}: key "${k}" sent`);
  g.players.forEach((p, i) => {
    const wp = json.players[i]!;
    if (canSee(p, viewer)) return;
    const cards = wp.cards as number[], all = wp.all as number[];
    if (cards.some(c => c !== HIDDEN) || all.some(c => c !== HIDDEN)) problems.push(`hand ${g.handNo}: viewer ${viewer} got ${p.name}'s cards`);
    if (cards.length !== p.cards.length) problems.push(`hand ${g.handNo}: ${p.name}'s card count wrong for viewer ${viewer}`);
    for (const k of PRIVATE_KEYS) if (k in wp) problems.push(`hand ${g.handNo}: viewer ${viewer} got ${p.name}'s ${k}`);
    if (json.hist.some(l => l.startsWith(`Dealt to ${p.name} [`) || l.startsWith(`${p.name} splits: `))) problems.push(`hand ${g.handNo}: viewer ${viewer} got ${p.name}'s private history line`);
  });
  if ((json.ev as Array<{ t?: string }>).some(e => e?.t === 'all')) problems.push('practice view sent');
  if (json.board.length !== g.boardVis) problems.push('board beyond what is dealt');
  const me = json.players.find(p => p.isHuman);
  if (viewer >= 0 && (!me || me.i !== viewer)) problems.push(`viewer ${viewer}: "you" is not their own seat`);
}

describe('online wire format', () => {
  it('never shows anyone else\'s hidden cards, over many hands of every game type with three people', () => {
    const problems: string[] = [];
    let steps = 0, viewsChecked = 0;
    const humanSplits = new Set<number>();
    for (const variant of ['holdem', 'std', 'two', 'k8', 'n7'] as VariantKey[]) {
      const g = threePeople('wire-' + variant);
      for (let h = 0; h < 4; h++) {
        const flow = playHand(g);
        let answer: unknown;
        for (;;) {
          const r = flow.next(answer);
          answer = undefined;
          if (r.done) break;
          const s = r.value;
          steps++;
          for (const viewer of [0, 1, 2, -1]) { check(g, viewer, encodeGame(g, viewer), problems); viewsChecked++; }
          if (s.kind === 'act') answer = s.p.isHuman ? scriptedHero.act(g, s.p) : botAction(g, s.p);
          else if (s.kind === 'variant') answer = s.p.isHuman ? variant : pickVariantFor(g, s.p);
          else if (s.kind === 'plans') initPlans(g, s.order);
          else if (s.kind === 'split') { if (s.p.isHuman) humanSplits.add(s.p.i); answer = s.p.isHuman ? planSplit(g, s.p, s.k) : botFinalSplit(g, s.p, s.k); }
          else if (s.kind === 'practiceView') practiceSplits(g);
          else if (s.kind === 'rebuy') answer = 'yes';
          // steps carry players by index and nothing private
          const ws = JSON.parse(JSON.stringify(encodeStep(s, g)));
          for (const k of NEVER) if (keysDeep(ws).has(k)) problems.push(`step ${s.kind}: key ${k}`);
          if ('p' in s && ws.p?.$p !== s.p.i) problems.push(`step ${s.kind}: player not sent by index`);
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(viewsChecked).toBeGreaterThan(1000);
    // every person at the table got their own split step (not just the first)
    expect([...humanSplits].sort()).toEqual([0, 1, 2]);
    console.log(`wire: ${steps} steps, ${viewsChecked} views checked, 0 leaks`);
  });

  it('decodes back into players with working references, keeping the page\'s seat elements', () => {
    const g = threePeople('wire-decode');
    const flow = playHand(g);
    let r = flow.next(), s: Step;
    for (;;) {
      if (r.done) throw new Error('hand ended before any action');
      s = r.value;
      if (s.kind === 'pause' && s.what === 'action') break;
      r = flow.next(s.kind === 'act' ? (s.p.isHuman ? scriptedHero.act(g, s.p) : botAction(g, s.p)) : s.kind === 'variant' ? 'holdem' : undefined);
    }
    const w = JSON.parse(JSON.stringify(encodeGame(g, 1)));
    const el = { seat: 'element' };
    const prev = g.players.map((p, i) => ({ name: p.name, seat: p.seat, el: i === 1 ? el : undefined }));
    const d = decodeGame(w, prev);
    expect(d.players[1]!.el).toBe(el);
    expect(d.players[1]!.isHuman).toBe(true);
    expect(d.players[0]!.isHuman).toBe(false); // another person: not "you" on this screen
    expect(d.players[0]!.human).toBe(true);
    const evWithP = (d.ev as Array<{ p?: unknown }>).find(e => e.p);
    expect(d.players).toContain(evWithP!.p);
    const step = decodeStep(JSON.parse(JSON.stringify(encodeStep(s, g))), d.players);
    expect(d.players).toContain((step.data as { p: unknown }).p);
  });
});
