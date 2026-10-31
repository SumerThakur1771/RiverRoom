// Hand-strength tables: starting-hand percentiles, 3 Patti and 5-card percentiles, and the
// split-game opponent model ("what other players usually end up with in each part").
import { cr, cs, evaluate, randCards, type Card } from './cards';
import type { Streams } from './rng';
import { tpScore } from './teenpatti';
import { normSplit, splitsOf, VARIANTS, type PartKind, type Variant, type VariantKey } from './variants';

/* ---- starting-hand strength: every 2-card hand gets a percentile (0 = best), from Chen scores ---- */
export const PCT = new Float32Array(15 * 15 * 2);
(function buildPct() {
  const val = (r: number): number => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  const chen = (h: number, l: number, s: number): number => {
    let sc: number;
    if (h === l) sc = Math.max(5, val(h) * 2) + (h === 5 ? 1 : 0);
    else {
      sc = val(h) + (s ? 2 : 0);
      const gap = h - l - 1;
      sc -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
      if (gap <= 1 && h < 12) sc += 1;
    }
    return sc + h * 0.01 + l * 0.001;
  };
  const list: Array<{ h: number; l: number; s: number; n: number; sc: number }> = [];
  for (let h = 2; h <= 14; h++)
    for (let l = 2; l <= h; l++) {
      if (h === l) list.push({ h, l, s: 0, n: 6, sc: chen(h, l, 0) });
      else {
        list.push({ h, l, s: 1, n: 4, sc: chen(h, l, 1) });
        list.push({ h, l, s: 0, n: 12, sc: chen(h, l, 0) });
      }
    }
  list.sort((a, b) => b.sc - a.sc);
  let cum = 0;
  for (const e of list) {
    PCT[(e.h * 15 + e.l) * 2 + e.s] = (cum + e.n / 2) / 1326;
    cum += e.n;
  }
})();

/** Percentile of a starting hand among all 1,326 (0 = best). */
export function handPct(a: Card, b: Card): number {
  let h = cr(a), l = cr(b);
  if (h < l) [h, l] = [l, h];
  return PCT[(h * 15 + l) * 2 + (h !== l && cs(a) === cs(b) ? 1 : 0)]!;
}

export function rangeText(top: number): string {
  if (top <= 0.035) return 'only the very best cards';
  if (top <= 0.07) return 'very strong cards';
  if (top <= 0.13) return 'strong cards';
  if (top <= 0.22) return 'good cards';
  if (top <= 0.36) return 'a mix of good and okay cards';
  if (top <= 0.6) return 'almost any cards, often weak ones';
  return 'any two cards';
}

/** Fraction of a sorted table below v (ties count half). */
export function sortedPct(tab: ArrayLike<number>, v: number): number {
  let lo = 0, hi = tab.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tab[m]! < v) lo = m + 1;
    else hi = m;
  }
  const a = lo;
  hi = tab.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tab[m]! <= v) lo = m + 1;
    else hi = m;
  }
  return (a + (lo - a) / 2) / tab.length;
}

/** All 22,100 3 Patti scores, sorted. Deterministic, so shared by every table. */
let TP_TAB: Float64Array | null = null;
export function tpTab(): Float64Array {
  if (!TP_TAB) {
    const a: number[] = [];
    for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) for (let k = j + 1; k < 52; k++) a.push(tpScore([i, j, k]));
    TP_TAB = Float64Array.from(a).sort();
  }
  return TP_TAB;
}

export const kPow = (k: number): number => 1 + (Math.max(1, k) - 1) * 0.6;

/**
 * Seed-dependent tables (built from samples), cached per seed. Each is built on its own
 * named stream, so the result never depends on which code path asked for it first.
 */
export class Tables {
  private h5: Float64Array | null = null;
  private readonly opp: Partial<Record<VariantKey, Float64Array[]>> = {};
  constructor(private readonly rs: Streams) {}

  /** 30,000 random 5-card hand values, sorted. */
  h5Tab(): Float64Array {
    if (!this.h5) this.h5 = this.rs.seg('h5tab', () => {
      const a = new Float64Array(30000);
      for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(this.rs.rand, 5));
      return a.sort();
    });
    return this.h5;
  }

  tpPct(h: readonly Card[]): number { return sortedPct(tpTab(), tpScore(h)); }
  h5Pct(h: readonly Card[]): number { return sortedPct(this.h5Tab(), evaluate(h)); }

  /** How strong one part is on its own, from 0 (worst) to 1 (best). */
  partStr(kind: PartKind, h: readonly Card[]): number {
    return kind === 'hold' ? 1 - handPct(h[0]!, h[1]!) : kind === 'h5' ? this.h5Pct(h) : this.tpPct(h);
  }
  memoStr(): (kind: PartKind, h: readonly Card[]) => number {
    const m = new Map<string, number>();
    return (kind, h) => {
      const key = kind + h.join(',');
      let v = m.get(key);
      if (v === undefined) {
        v = this.partStr(kind, h);
        m.set(key, v);
      }
      return v;
    };
  }

  /** What the other players usually end up with in each part (simulated once per game type). */
  oppDist(key: VariantKey): Float64Array[] {
    const hit = this.opp[key];
    if (hit) return hit;
    const res = this.rs.seg('opp:' + key, () => {
      const rand = this.rs.rand;
      const V: Variant = VARIANTS[key], N = key === 'k8' ? 700 : key === 'n7' ? 1200 : 2000;
      const cols: number[][] = V.parts.map(() => []);
      for (let i = 0; i < N; i++) {
        const memo = this.memoStr();
        let best: Card[][] | null = null, bv = -1;
        for (const s of splitsOf(V, randCards(rand, V.deal), true)) {
          let v = 0;
          V.parts.forEach((pt, j) => (v += memo(pt.k, s[j]!)));
          if (v > bv) {
            bv = v;
            best = s;
          }
        }
        let b = normSplit(V, best!);
        // most people put their stronger 3 Patti 1st, but not everyone
        if (V.parts.length === 3 && rand() < 0.4) b = [b[0]!, b[2]!, b[1]!];
        V.parts.forEach((pt, j) => cols[j]!.push(memo(pt.k, b[j]!)));
      }
      return cols.map(c => Float64Array.from(c).sort());
    });
    this.opp[key] = res;
    return res;
  }

  oppCdf(key: VariantKey, j: number, str: number): number {
    return sortedPct(this.oppDist(key)[j]!, str);
  }
}
