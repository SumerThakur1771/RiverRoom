// The home game's roster: edits, validation, and games built from it (who is human, who the
// computer plays, and that real hands work at every table size from 2 to 6).
import { describe, expect, it } from 'vitest';
import { newGame } from '../src/engine/engine';
import { TYPES } from '../src/engine/personas';
import { addCharacter, cleanName, DEFAULT_ROSTER, removeCharacter, renameCharacter, ROSTER_MAX, ROSTER_MIN, STYLES, validRoster, type Character } from '../src/engine/roster';
import { runHand, runSession, scriptedHero } from '../src/sim/driver';
import { cardsNeeded, variantFits } from '../src/engine/variants';

const SETTINGS = { name: '', opp: 4, stack: 1000, perLevel: 10, revealAll: true, games: 'dealer' as const };
const ok = (r: ReturnType<typeof addCharacter>): Character[] => { if (!r.ok) throw new Error(r.error); return r.roster; };

describe('roster', () => {
  it('starts with Sumer and his four friends, each with a home-game style', () => {
    expect(DEFAULT_ROSTER.map(c => c.name)).toEqual(['Sumer', 'Rohit', 'Krish', 'Nikhil', 'Venky']);
    expect(DEFAULT_ROSTER.every(c => c.original && TYPES[c.type]?.home)).toBe(true);
    expect(TYPES.sumer!.label).toBe('Balanced');
  });
  it('renames: trims, caps the length, refuses empty names and names already at the table (any case)', () => {
    expect(ok(renameCharacter(DEFAULT_ROSTER, 'rohit', '  Ro   the  Rock  ')).find(c => c.id === 'rohit')!.name).toBe('Ro the Rock');
    expect(cleanName('a'.repeat(30))).toHaveLength(12);
    expect(renameCharacter(DEFAULT_ROSTER, 'rohit', '   ')).toMatchObject({ ok: false });
    expect(renameCharacter(DEFAULT_ROSTER, 'rohit', 'kRiSh')).toMatchObject({ ok: false, error: 'kRiSh is already at the table.' });
    expect(renameCharacter(DEFAULT_ROSTER, 'rohit', 'Rohit').ok).toBe(true); // keeping your own name is fine
  });
  it('adds up to six players, with a home-game style, a fresh id and colour', () => {
    const r = ok(addCharacter(DEFAULT_ROSTER, 'Asha', 'nikhil'));
    expect(r).toHaveLength(6);
    expect(r[5]).toMatchObject({ id: 'p1', name: 'Asha', type: 'nikhil', avatar: null, original: false });
    expect(new Set(r.map(c => c.color)).size).toBe(6);
    expect(addCharacter(r, 'Seventh', 'rohit')).toMatchObject({ ok: false, error: `The table seats ${ROSTER_MAX}.` });
    expect(addCharacter(DEFAULT_ROSTER, 'Zed', 'maniac')).toMatchObject({ ok: false }); // tournament styles are not home-game styles
    expect(addCharacter(DEFAULT_ROSTER, 'sumer', 'rohit')).toMatchObject({ ok: false });
  });
  it('removes anyone, originals included, down to two players', () => {
    let r: Character[] = [...DEFAULT_ROSTER];
    for (const id of ['sumer', 'rohit', 'krish']) r = ok(removeCharacter(r, id));
    expect(r.map(c => c.name)).toEqual(['Nikhil', 'Venky']);
    expect(removeCharacter(r, 'nikhil')).toMatchObject({ ok: false, error: `A game needs at least ${ROSTER_MIN} players.` });
    // ids of removed players are reused only for added players' own numbering
    expect(ok(addCharacter(r, 'Sumer', 'sumer'))[2]!.id).toBe('p1');
  });
  it('validates rosters from outside: size, unique ids and names, known styles; faces only for the originals', () => {
    expect(validRoster(DEFAULT_ROSTER)).toEqual(DEFAULT_ROSTER);
    expect(validRoster([DEFAULT_ROSTER[0]])).toBeNull();
    expect(validRoster([...DEFAULT_ROSTER, ...DEFAULT_ROSTER.slice(0, 2)])).toBeNull();
    expect(validRoster([DEFAULT_ROSTER[0], { ...DEFAULT_ROSTER[1], name: 'SUMER' }])).toBeNull();
    expect(validRoster([DEFAULT_ROSTER[0], { ...DEFAULT_ROSTER[1], type: 'nope' }])).toBeNull();
    expect(validRoster([DEFAULT_ROSTER[0], { id: 'p1', name: '<b>Al</b>\u0007', type: 'rohit', color: 'red', avatar: 'rohit' }])).toEqual([
      DEFAULT_ROSTER[0], { id: 'p1', name: '<b>Al</b>', type: 'rohit', color: '#8e9f96', avatar: null, original: false },
    ]);
    expect(validRoster('nope')).toBeNull();
    expect(STYLES.every(s => TYPES[s]?.home)).toBe(true);
  });
});

describe('games built from a roster', () => {
  it('the person plays the character they picked; the computer plays everyone else in their own style (Sumer included)', () => {
    const g = newGame({ mode: 'home', seed: 'roster-1', settings: SETTINGS, roster: DEFAULT_ROSTER, heroId: 'rohit' });
    const me = g.players[0]!;
    expect(me).toMatchObject({ isHuman: true, name: 'Rohit', avatar: 'rohit', type: null });
    const sumer = g.players.find(p => p.name === 'Sumer')!;
    expect(sumer).toMatchObject({ isHuman: false, type: 'sumer', avatar: 'sumer' });
    expect(g.players.filter(p => !p.isHuman).map(p => p.name).sort()).toEqual(['Krish', 'Nikhil', 'Sumer', 'Venky']);
  });
  it('without a roster the game is exactly as before (Sumer against the four friends)', () => {
    const a = newGame({ mode: 'home', seed: 'same', settings: SETTINGS });
    const b = newGame({ mode: 'home', seed: 'same', settings: SETTINGS, roster: DEFAULT_ROSTER, heroId: 'sumer' });
    expect(b.players.map(p => [p.name, p.seat, p.type])).toEqual(a.players.map(p => [p.name, p.seat, p.type]));
  });
  it('a game the deck cannot deal at this size is played as Poker + 3 Patti (8 cards to 6 players needs 53 cards)', () => {
    expect(cardsNeeded('k8', 6)).toBe(53);
    expect(variantFits('k8', 6)).toBe(false);
    expect((['holdem', 'std', 'two', 'n7'] as const).every(k => variantFits(k, 6))).toBe(true);
    expect((['holdem', 'std', 'two', 'k8', 'n7'] as const).every(k => variantFits(k, 5))).toBe(true);
    const r = ok(addCharacter(DEFAULT_ROSTER, 'Asha', 'krish'));
    const g = newGame({ mode: 'home', seed: 'k8-six', settings: SETTINGS, roster: r, heroId: 'sumer' });
    const s = runHand(g, scriptedHero, { forceVariant: 'k8' });
    expect(g.variant).toBe('std');
    expect(s.lines.some(l => /8 cards: two 3 Patti needs more cards than one deck has at 6 players/.test(l))).toBe(true);
  });
  it.each([2, 3, 4, 5, 6])('plays real hands, every game type, at a table of %i', n => {
    let r: Character[] = [...DEFAULT_ROSTER];
    while (r.length > n) r = ok(removeCharacter(r, r[r.length - 1]!.id));
    if (n === 6) r = ok(addCharacter(r, 'Asha', 'krish'));
    const g = newGame({ mode: 'home', seed: 'roster-size-' + n, settings: SETTINGS, roster: r, heroId: r[r.length - 1]!.id });
    expect(g.players).toHaveLength(n);
    expect(new Set(g.players.map(p => p.seat)).size).toBe(n);
    const chips = g.players.reduce((a, p) => a + p.stack, 0);
    let played = 0;
    for (const v of ['holdem', 'std', 'two', 'k8', 'n7'] as const) played += runSession(g, scriptedHero, 2, { forceVariant: v });
    expect(played).toBe(10);
    // chips are conserved, counting rebuys
    expect(g.players.reduce((a, p) => a + p.stack, 0)).toBe(chips + g.players.reduce((a, p) => a + (p.buyins - 1) * 1000, 0));
  });
});
