// Seeded randomness with named streams.
//
// Every random decision in the game runs inside a named "segment" (for example `h12:ai:3`,
// the 4th bot decision of hand 12). Each segment draws from its own generator, seeded by
// hash(tableSeed + '|' + label). Consequences:
//  - a whole session replays exactly from one seed string;
//  - changing cosmetic randomness (chat, sounds) or one bot's logic cannot shift the cards
//    or any other decision;
//  - the original single-file game, patched the same way (tools/golden/record.mjs), produces
//    the golden traces this code is tested against.

export type Rng = () => number;

/** 32-bit FNV-1a hash of a string. */
export function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good-enough PRNG for games and simulations. Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform 32-bit integer from a [0,1) source, as the legacy deck fallback did. */
export const u32 = (rand: Rng): number => (rand() * 4294967296) >>> 0;

export class Streams {
  private cur: Rng;
  private readonly stack: Rng[] = [];
  private counters = new Map<string, number>();
  private counterHand = -1;

  /**
   * @param seed table seed; `null` means live play: each segment gets a fast generator seeded
   *             from the platform's crypto RNG, and the deck draws from crypto directly.
   *             (Drawing every number from crypto was about 160x slower and made the
   *             Monte Carlo equity estimates block for longer; see METRICS.md.)
   */
  constructor(
    readonly seed: string | null,
    private readonly entropy: Rng = cryptoRandom,
  ) {
    this.cur = seed === null ? mulberry32(u32(entropy)) : mulberry32(hash32('ui'));
  }

  /** The current stream. Pass this to helpers that need randomness. */
  readonly rand: Rng = () => this.cur();

  /** Run `fn` with its own stream for `label`; the previous stream resumes afterwards. */
  seg<T>(label: string, fn: () => T): T {
    this.stack.push(this.cur);
    this.cur = this.seed !== null ? mulberry32(hash32(this.seed + '|' + label)) : label.endsWith(':deck') ? this.entropy : mulberry32(u32(this.entropy));
    try {
      return fn();
    } finally {
      this.cur = this.stack.pop() as Rng;
    }
  }

  /** Label with a per-hand counter, e.g. `h12:ai:3`. Counters reset when the hand changes. */
  label(hand: number, name: string): string {
    if (hand !== this.counterHand) {
      this.counterHand = hand;
      this.counters = new Map();
    }
    const k = (this.counters.get(name) ?? -1) + 1;
    this.counters.set(name, k);
    return 'h' + hand + ':' + name + ':' + k;
  }

  /** Deterministic integer for a label without consuming any stream (used by scripted players). */
  hashOf(label: string): number {
    return hash32((this.seed ?? 'live') + '|' + label);
  }
}

/** Uniform [0,1) from the platform CSPRNG. */
export function cryptoRandom(): number {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return (b[0] as number) / 4294967296;
}
