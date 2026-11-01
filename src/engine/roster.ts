// The home game's roster: who sits at the table. Sumer and his four friends by default; the
// roster can be renamed, extended and trimmed. Each person picks the character they play; every
// character nobody picks is played by the computer in that character's style.
//
// Plain data and pure functions, shared by the single-player screen, the server and tests.
import { HOME_FRIENDS, TYPES } from './personas';

export interface Character {
  /** Stable id: the original five keep theirs ('sumer', 'rohit', ...); added ones get 'p1', 'p2', ... */
  id: string;
  name: string;
  /** Playing style when the computer plays this character (a home-game persona key). */
  type: string;
  color: string;
  /** Drawn face for the original five; added characters show their initial. */
  avatar: string | null;
  original: boolean;
}

export const SUMER: Character = { id: 'sumer', name: 'Sumer', type: 'sumer', color: '#b8902f', avatar: 'sumer', original: true };
export const DEFAULT_ROSTER: readonly Character[] = [
  SUMER,
  ...HOME_FRIENDS.map(f => ({ id: f.type, name: f.name, type: f.type, color: f.color, avatar: f.avatar, original: true })),
];
/** The table has six seats; a game needs two players. */
export const ROSTER_MIN = 2;
export const ROSTER_MAX = 6;
export const NAME_MAX = 12;
/** Styles a character can play in when the computer plays them: the home-game personas. */
export const STYLES: readonly string[] = ['sumer', 'nikhil', 'krish', 'rohit', 'venky'];
const NEW_COLORS = ['#7d5cc6', '#c74f86', '#4aa3a0', '#9a7b4f', '#5b8def', '#d06a3c'];

/** Trim, collapse spaces, drop control characters, cap the length. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from user input
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
const nameTaken = (r: readonly Character[], name: string, except?: string): boolean =>
  r.some(c => c.id !== except && c.name.toLowerCase() === name.toLowerCase());

export type RosterResult = { ok: true; roster: Character[] } | { ok: false; error: string };

export function renameCharacter(r: readonly Character[], id: string, raw: string): RosterResult {
  const name = cleanName(raw);
  if (!name) return { ok: false, error: 'Type a name.' };
  if (!r.some(c => c.id === id)) return { ok: false, error: 'No such player.' };
  if (nameTaken(r, name, id)) return { ok: false, error: `${name} is already at the table.` };
  return { ok: true, roster: r.map(c => (c.id === id ? { ...c, name } : c)) };
}

export function addCharacter(r: readonly Character[], raw: string, type: string): RosterResult {
  const name = cleanName(raw);
  if (r.length >= ROSTER_MAX) return { ok: false, error: `The table seats ${ROSTER_MAX}.` };
  if (!name) return { ok: false, error: 'Type a name.' };
  if (nameTaken(r, name)) return { ok: false, error: `${name} is already at the table.` };
  if (!STYLES.includes(type)) return { ok: false, error: 'Pick a playing style.' };
  let n = 1;
  while (r.some(c => c.id === 'p' + n)) n++;
  const color = NEW_COLORS.find(col => !r.some(c => c.color === col)) ?? NEW_COLORS[n % NEW_COLORS.length]!;
  return { ok: true, roster: [...r, { id: 'p' + n, name, type, color, avatar: null, original: false }] };
}

export function removeCharacter(r: readonly Character[], id: string): RosterResult {
  if (!r.some(c => c.id === id)) return { ok: false, error: 'No such player.' };
  if (r.length <= ROSTER_MIN) return { ok: false, error: `A game needs at least ${ROSTER_MIN} players.` };
  return { ok: true, roster: r.filter(c => c.id !== id) };
}

/**
 * Check a roster from outside (saved settings, a client message): right size, unique ids and
 * names, known styles. Returns a cleaned copy, or null if it cannot be used.
 */
export function validRoster(raw: unknown): Character[] | null {
  if (!Array.isArray(raw) || raw.length < ROSTER_MIN || raw.length > ROSTER_MAX) return null;
  const out: Character[] = [];
  for (const x of raw as Array<Partial<Character>>) {
    if (!x || typeof x.id !== 'string' || !/^[a-z0-9-]{1,20}$/.test(x.id) || typeof x.name !== 'string') return null;
    const name = cleanName(x.name);
    const type = typeof x.type === 'string' && STYLES.includes(x.type) && TYPES[x.type] ? x.type : null;
    if (!name || !type || out.some(c => c.id === x.id) || nameTaken(out, name)) return null;
    const original = DEFAULT_ROSTER.find(c => c.id === x.id);
    out.push({
      id: x.id, name, type,
      color: typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#8e9f96',
      avatar: original ? original.avatar : null,
      original: !!original,
    });
  }
  return out;
}

export const styleLabel = (type: string): string => TYPES[type]?.label ?? type;
