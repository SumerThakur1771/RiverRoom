// Server-side review cache: a hand that was already reviewed is answered from memory, and two
// requests for the same hand at the same time share one model call.
import type { ChainOutcome } from './openrouter.js';

export interface CachedReview { review: Extract<ChainOutcome, { ok: true }>['review']; model: string; paid: boolean }

export class ReviewCache {
  private readonly done = new Map<string, CachedReview>();
  private readonly pending = new Map<string, Promise<ChainOutcome>>();
  constructor(private readonly max = 500) {}

  get(key: string): CachedReview | undefined {
    const hit = this.done.get(key);
    if (hit) { this.done.delete(key); this.done.set(key, hit); } // most recently used goes last
    return hit;
  }
  /** A model call already running for this key, if any. */
  inFlight(key: string): Promise<ChainOutcome> | undefined { return this.pending.get(key); }

  /** Run `work` for this key unless it is already running; store a successful review. */
  track(key: string, work: Promise<ChainOutcome>): Promise<ChainOutcome> {
    this.pending.set(key, work);
    return work.then(out => {
      if (out.ok) {
        this.done.set(key, { review: out.review, model: out.model, paid: out.paid });
        if (this.done.size > this.max) this.done.delete(this.done.keys().next().value!);
      }
      return out;
    }).finally(() => this.pending.delete(key));
  }
  get size(): number { return this.done.size; }
}
