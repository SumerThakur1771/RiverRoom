// Player types. The home-game friends are modelled on the real players at Sumer's table.
import type { Rng } from './rng';
import type { Persona } from './state';
import { clamp } from './table';

export const NAMES: Array<[string, string]> = [['Marco', '#c2573b'], ['Priya', '#3b88c2'], ['Dmitri', '#7d5cc6'], ['Hana', '#35a274'], ['Leo', '#d39a2e'], ['Grace', '#c74f86'], ['Sam', '#4aa3a0'], ['Tomás', '#9a7b4f'], ['Aiko', '#6f86d6'], ['Nadia', '#b85b5b'], ['Owen', '#5d9c4a'], ['Ravi', '#c98a3a']];

export const TYPES: Record<string, Persona> = {
  station: { label: 'Calling station', open: .5, limp: .85, limpTop: .55, call: 2.0, three: .3, cbet: .35, bluff: .04, aggr: .35, sticky: .85, trap: .2, cr: .04, size: 'odd', noise: .12, tiltProne: .3, adapt: 0, tell: .8, chat: .25, donk: .25,
    desc: 'Plays lots of hands and calls bets with almost anything, but rarely raises.', beat: 'Bet your good hands big and often, because they will pay you. Do not bluff them: they call.' },
  rock: { label: 'Rock', open: .5, limp: .05, limpTop: 0, call: .55, three: .6, cbet: .55, bluff: .03, aggr: .6, sticky: .1, trap: .15, cr: .05, size: 'std', noise: .03, tiltProne: .1, adapt: .2, tell: .6, chat: .1, donk: .02,
    desc: 'Plays very few hands. When they bet or raise, they almost always have it.', beat: 'Steal their blinds often and fold medium hands when they show strength.' },
  tag: { label: 'Solid regular', open: 1.2, limp: 0, limpTop: 0, call: 1, three: 1, cbet: .68, bluff: .2, aggr: .75, sticky: .3, trap: .12, cr: .1, size: 'std', noise: .03, tiltProne: .2, adapt: .8, tell: .1, chat: .1, donk: .03,
    desc: 'Tight and aggressive: plays good hands, bets them hard, and pays attention to you.', beat: 'Avoid big pots without a strong hand. Mix up your play so they cannot read you.' },
  lag: { label: 'Loose-aggressive', open: 1.45, limp: 0, limpTop: 0, call: 1.2, three: 1.7, cbet: .78, bluff: .32, aggr: .85, sticky: .35, trap: .1, cr: .15, size: 'std', noise: .05, tiltProne: .35, adapt: .8, tell: .15, chat: .2, donk: .05,
    desc: 'Plays many hands and puts constant pressure on you with bets and raises.', beat: 'Call down lighter with decent hands and let them bluff into your strong ones.' },
  maniac: { label: 'Maniac', open: 2.3, limp: .1, limpTop: .6, call: 1.6, three: 2.8, cbet: .9, bluff: .48, aggr: .95, sticky: .45, trap: .05, cr: .2, size: 'big', noise: .1, tiltProne: .7, adapt: .2, tell: .3, chat: .5, donk: .15,
    desc: 'Raises and bluffs constantly, often with nothing.', beat: 'Wait for good hands, then let them bet into you. Call more, bluff less.' },
  weak: { label: 'Cautious', open: .8, limp: .3, limpTop: .25, call: .8, three: .5, cbet: .45, bluff: .08, aggr: .45, sticky: .15, trap: .1, cr: .05, size: 'small', noise: .05, tiltProne: .2, adapt: .3, tell: .5, chat: .1, donk: .05,
    desc: 'Plays reasonable hands but gives up easily when someone bets.', beat: 'Bet at pots they check. Believe them when they raise.' },
  tricky: { label: 'Trapper', open: 1.15, limp: .1, limpTop: .2, call: 1.2, three: 1.2, cbet: .6, bluff: .26, aggr: .7, sticky: .35, trap: .45, cr: .35, size: 'std', noise: .05, tiltProne: .25, adapt: .7, tell: .2, chat: .15, donk: .05,
    desc: 'Slow-plays big hands and loves to check-raise.', beat: 'Be careful when they suddenly wake up with a raise after checking.' },
  casual: { label: 'Casual', open: .8, limp: .6, limpTop: .45, call: 1.5, three: .5, cbet: .5, bluff: .16, aggr: .5, sticky: .6, trap: .15, cr: .05, size: 'odd', noise: .1, tiltProne: .4, adapt: .1, tell: .6, chat: .6, donk: .2,
    desc: 'A recreational player: limps a lot, chases draws and chats.', beat: 'Raise their limps, bet your made hands, and make draws pay.' },
  // Sumer's home game: the friends, as described by Sumer
  // Sumer himself, for when somebody else plays his seat: strong and balanced, close to what the
  // app's coach recommends (Nikhil's all-round game, steadier: fewer bluffs, less tilt)
  sumer: { home: true, raisePre: .3, bigValue: .75, label: 'Balanced', open: .8, limp: .55, limpTop: .5, call: .85, three: .95, cbet: .6, bluff: .14, aggr: .75, sticky: .2, trap: .15, cr: .1, size: 'home', noise: .02, tiltProne: .08, adapt: .9, tell: .05, chat: .15, donk: .04, stab: .6,
    desc: 'Plays solid, sensible poker: good hands strongly, weak hands rarely, a bluff now and then. Hard to push around and hard to read.', beat: 'Do not expect easy money. Play good hands, pick your spots, and change your bet sizes.' },
  rohit: { home: true, raisePre: .2, label: 'Tight folder', open: .4, limp: .9, limpTop: .45, call: .6, three: .4, cbet: .4, bluff: .04, aggr: .55, sticky: .06, trap: .1, cr: .04, size: 'home', noise: .02, tiltProne: .1, adapt: .3, tell: .3, chat: .2, donk: .05, bigFold: true, quickFold: true, stab: .4,
    desc: 'Plays mostly good hands. If someone bets big and he has nothing decent, he folds fast. He only calls a $1 bet with a strong hand.', beat: 'Bet bigger when you want him out, because he folds weak hands to pressure. When he calls or raises a big bet, believe him.' },
  krish: { home: true, raisePre: .3, label: 'Bluffer', open: .55, limp: .85, limpTop: .62, call: 1, three: .6, cbet: .6, bluff: .26, aggr: .75, sticky: .3, trap: .1, cr: .1, size: 'home', noise: .04, tiltProne: .3, adapt: .4, tell: .3, chat: .35, donk: .1, stab: 1.8, overplay: .4,
    desc: 'Plays strong hands, bets a medium pair like it is a monster, and bluffs when nobody else shows strength. When he is really strong, he raises your big bets.', beat: 'When everyone checks and Krish suddenly bets, he is often bluffing. Call him down with a decent pair more often.' },
  nikhil: { home: true, raisePre: .35, bigValue: .8, label: 'Strong all-rounder', open: .85, limp: .6, limpTop: .55, call: .9, three: 1, cbet: .62, bluff: .18, aggr: .8, sticky: .22, trap: .15, cr: .12, size: 'home', noise: .02, tiltProne: .15, adapt: .9, tell: .05, chat: .2, donk: .04, stab: .7,
    desc: 'The best player at the table: bets bigger when his hand is strong, folds smartly, bluffs sometimes, and pays attention to how you play. Calls a $1 bet only with a strong hand.', beat: 'Avoid big pots with him unless your hand is strong, and change up your bet sizes so he cannot read you.' },
  venky: { home: true, raisePre: .1, label: 'Wild card', open: .6, limp: .95, limpTop: .85, call: 1.8, three: .5, cbet: .4, bluff: .3, aggr: .5, sticky: .75, trap: .1, cr: .05, size: 'wild', noise: .35, tiltProne: .3, adapt: 0, tell: 0, chat: .35, donk: .25, clueless: true, slow: 2.2, stab: .6,
    desc: 'Plays almost any hand and does not always know how strong his hand is. Makes random big bets, takes forever to act, and calls big bets whenever he thinks he has a good pair.', beat: 'Never bluff Venky, because he calls. When you have a good hand, bet big: he will pay you. Do not read too much into his big bets.' },
};

export interface Friend { name: string; type: string; color: string; avatar: string }
export const HOME_FRIENDS: Friend[] = [
  { name: 'Rohit', type: 'rohit', color: '#3b88c2', avatar: 'rohit' },
  { name: 'Krish', type: 'krish', color: '#c2573b', avatar: 'krish' },
  { name: 'Nikhil', type: 'nikhil', color: '#35a274', avatar: 'nikhil' },
  { name: 'Venky', type: 'venky', color: '#d39a2e', avatar: 'venky' },
];

/** Each table gets slightly different versions of each type (±15% on the main tendencies). */
export function jitter(rand: Rng, t: Persona): Persona {
  const o: Persona = Object.assign({}, t);
  const rnd = (a: number, b: number): number => a + rand() * (b - a);
  for (const k of ['open', 'call', 'three', 'cbet', 'bluff', 'aggr', 'sticky', 'trap', 'limp'] as const) o[k] = t[k] * rnd(0.85, 1.15);
  o.cbet = clamp(o.cbet, 0, 0.95);
  o.aggr = clamp(o.aggr, 0, 0.98);
  o.sticky = clamp(o.sticky, 0, 0.95);
  return o;
}

/** Preflop opening and shoving frequencies by position. */
export const OPEN = { hu: .7, sb: .4, btn: .45, co: .28, hj: .2, ep: .15, bb: .15 };
export const PUSH = { hu: .65, sb: .5, btn: .38, co: .25, hj: .18, ep: .14, bb: .4 };
