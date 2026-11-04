// Dealer's-choice game variants. Each splits a player's cards into parts; each part wins
// its own share of the pot (with a 2-of-3 majority rule for the 8-card game).
import type { Card } from './cards';
import { tpScore } from './teenpatti';

export type PartKind = 'hold' | 'tp' | 'b2' | 'h5';
export interface Part { k: PartKind; n: number; label: string; sh?: string }
export type VariantKey = 'holdem' | 'std' | 'two' | 'k8' | 'n7';
export interface Variant { key: VariantKey; name: string; short: string; deal: number; board2?: number; parts: Part[]; say: string[]; desc: string }

export const VARIANTS: Record<VariantKey, Variant> = {
  holdem: { key: 'holdem', name: 'Simple poker', short: 'Simple', deal: 2, parts: [{ k: 'hold', n: 2, label: 'Poker' }], say: ['simple poker', 'just poker'],
    desc: "Normal Texas Hold'em: 2 cards each, 5 cards on the table." },
  std: { key: 'std', name: 'Poker + 3 Patti', short: 'Standard', deal: 5, parts: [{ k: 'hold', n: 2, label: 'Poker' }, { k: 'tp', n: 3, label: '3 Patti', sh: '3 Patti' }], say: ['standard', 'normal one', '3 patti one'],
    desc: '5 cards each. Pick 2 for normal poker with the table cards and 3 for a 3 Patti hand. Half the pot goes to the best poker hand, half to the best 3 Patti hand.' },
  two: { key: 'two', name: 'Two boards', short: 'Two boards', deal: 5, board2: 2, parts: [{ k: 'hold', n: 2, label: 'Board 1' }, { k: 'b2', n: 3, label: 'Board 2', sh: 'Board 2' }], say: ['two boards', 'double board'],
    desc: "5 cards each and 7 table cards: the normal 5 plus a second board of 2. Pick 2 cards for board 1 (normal poker) and 3 cards that must play with board 2's two cards. Both board 2 cards open together with the flop. Half the pot for each board." },
  k8: { key: 'k8', name: '8 cards: two 3 Patti', short: '8 cards', deal: 8, parts: [{ k: 'hold', n: 2, label: 'Poker' }, { k: 'tp', n: 3, label: '1st 3 Patti', sh: '1st' }, { k: 'tp', n: 3, label: '2nd 3 Patti', sh: '2nd' }], say: ['8 cards', 'two 3 patti'],
    desc: "8 cards each. Use 2 for poker and make two 3 Patti hands with the other 6. You decide which 3 Patti plays 1st and which plays 2nd: everyone's 1st hands play each other, and so do the 2nd hands. Win 2 of the 3 parts and you take the whole pot; if three different players win one part each, it is split in three." },
  n7: { key: 'n7', name: '7 cards: hand poker', short: '7 cards', deal: 7, parts: [{ k: 'hold', n: 2, label: 'Poker' }, { k: 'h5', n: 5, label: 'Hand poker', sh: 'Hand' }], say: ['7 cards', 'hand poker one'],
    desc: '7 cards each. Pick 2 for normal poker and make a 5-card poker hand from the other 5 (no table cards). Half the pot for each.' },
};
export const VAR_ORDER: VariantKey[] = ['std', 'holdem', 'two', 'k8', 'n7'];
/** Cards a deal needs: every player's hand, the board (5) and a second board if any. */
export const cardsNeeded = (key: VariantKey, players: number): number => VARIANTS[key].deal * players + 5 + (VARIANTS[key].board2 ?? 0);
/** Can this game be dealt to this many players from one deck? (8 cards to 6 players cannot: 53 cards.) */
export const variantFits = (key: VariantKey, players: number): boolean => cardsNeeded(key, players) <= 52;
/** What each friend usually deals. */
export const DEALER_PICKS: Record<string, Array<[VariantKey, number]>> = {
  rohit: [['std', 0.75], ['two', 0.25]],
  krish: [['k8', 0.6], ['std', 0.4]],
  nikhil: [['n7', 0.55], ['holdem', 0.45]],
  venky: [['std', 0.7], ['holdem', 0.3]],
  sumer: [['std', 0.5], ['holdem', 0.3], ['n7', 0.2]],
};

/** A split: one card group per part, in part order. */
export type Split = Card[][];

export function combos<T>(arr: readonly T[], k: number): T[][] {
  const out: T[][] = [], acc: T[] = [];
  const go = (s: number): void => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = s; i <= arr.length - (k - acc.length); i++) {
      acc.push(arr[i]!);
      go(i + 1);
      acc.pop();
    }
  };
  go(0);
  return out;
}

/** Every way to share the cards out between the parts. `unordered` drops mirror 3 Patti orders. */
export function splitsOf<T>(V: Variant, cards: readonly T[], unordered?: boolean): T[][][] {
  let res: T[][][] = [[]];
  for (const pt of V.parts) {
    const next: T[][][] = [];
    for (const pre of res) {
      const used = new Set(([] as T[]).concat(...pre));
      for (const c of combos(cards.filter(x => !used.has(x)), pt.n)) next.push(pre.concat([c]));
    }
    res = next;
  }
  if (unordered && V.parts.length === 3) res = res.filter(s => (s[1]![0] as unknown as number) < (s[2]![0] as unknown as number));
  return res;
}

/** Strongest 3 Patti first (under the table's A-2-3 rule). */
export function normSplit(V: Variant, s: Split, a23Low = false): Split {
  if (V.parts.length === 3 && V.parts[1]!.k === 'tp' && tpScore(s[1]!, a23Low) < tpScore(s[2]!, a23Low)) return [s[0]!, s[2]!, s[1]!];
  return s;
}
