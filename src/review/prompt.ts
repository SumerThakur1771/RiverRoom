// The prompt for the AI review: a short system prompt and a compact view of the hand. Plain
// TypeScript with no dependencies, so the browser can build the same text to compute the same
// cache key as the server without loading zod.
import type { Decision, ReviewRequest } from './review.js';

/** Bump when the prompt changes, so cached reviews from the old prompt are not reused. */
export const PROMPT_VERSION = 'v2';

export const SYSTEM_PROMPT = `You coach a beginner at poker. Review the player's decisions in one finished hand, using only the hand and numbers given.
Reply with only this JSON object, no other text:
{"grade":"great|good|fine|mistake|blunder","mistake":string or null,"lesson":string}
mistake: the costliest mistake in one plain sentence that names the street and what to do instead, or null if none.
lesson: one concrete habit to practise, in one or two short sentences.
Use simple English; explain any poker word.`;

const STREET = ['Preflop', 'Flop', 'Turn', 'River'];

/**
 * The hand log without what a review does not need: table and seat headers become one stacks
 * line; table chat, the practice-view card dump (folded players' cards, which the player
 * could not see) and the summary are dropped.
 */
export function compactHand(hand: string): string {
  const out: string[] = [], stacks: string[] = [];
  let skip = false;
  for (const raw of hand.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\*\*\* (ALL CARDS|SUMMARY)/.test(line)) { skip = true; continue; }
    if (/^\*\*\* /.test(line)) skip = false;
    // table chat ("Venky said, ...") is cosmetic and depends on timing
    if (skip || /^Table /.test(line) || line === '*** HOLE CARDS ***' || /^[^:]{1,40} said, "/.test(line)) continue;
    const seat = /^Seat \d+: (.+?) \((.+?) in chips\)/.exec(line);
    if (seat) { stacks.push(`${seat[1]} ${seat[2]}`); continue; }
    if (stacks.length && !out.some(l => l.startsWith('Stacks:'))) out.push('Stacks: ' + stacks.join(', '));
    out.push(line.replace(/^\*\*\* (.+?) \*\*\*/, '$1:'));
  }
  return out.join('\n');
}

/** One short line per decision. */
export function decisionLine(d: Decision, money: boolean): string {
  const amt = (x: number): string => (money ? '$' + (x / 100).toFixed(2) : String(x));
  const pct = (x: number): string => Math.round(x * 100) + '%';
  const parts = [`${d.st < 0 ? 'Split' : STREET[d.st]}${d.pos ? ' ' + d.pos : ''}: ${d.act}${d.to ? ' to ' + amt(d.to) : ''}`];
  if (d.split) parts.push('split ' + d.split);
  if (d.pot !== undefined) parts.push('pot ' + amt(d.pot));
  if (d.toCall) parts.push('to call ' + amt(d.toCall));
  if (d.eq !== undefined) parts.push(`win chance ${pct(d.eq)}${d.need ? ', needed ' + pct(d.need) : ''}`);
  parts.push(`app coach: ${d.rec ? d.rec + ', ' : ''}graded ${d.grade}${d.cat ? ' (' + d.cat + ')' : ''}`);
  return parts.join('; ');
}

export function buildUserMessage(req: ReviewRequest): string {
  const money = !!req.money;
  return [
    req.game ? `Game: ${req.game}. ${req.gameDesc ?? ''}`.trim() : 'Game: No-Limit Hold\'em.',
    money ? 'Home cash game, blinds $0.10/$0.20.' : 'Tournament (chips).',
    compactHand(req.hand),
    'Player decisions (win chance vs likely hands; needed = pot odds):',
    ...req.decisions.map(d => decisionLine(d, money)),
  ].join('\n');
}
