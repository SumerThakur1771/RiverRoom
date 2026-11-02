// End-of-night settlement: who pays whom, in as few transfers as possible.
//
// Everyone's balance is (cashed out + chips still on the table) - (bought in). The fewest
// transfers that settle all balances is n - g, where n is the number of people with a
// nonzero balance and g is the largest number of groups those people can be split into so
// that each group's balances add up to zero (each group of k people needs k - 1 transfers).
// Finding g is a set-partition problem (NP-hard in general); for a home game (at most a few
// dozen people, and in practice under 10) a bitmask dynamic program over subsets is exact
// and instant. Above MAX_EXACT people it falls back to the greedy method (at most n - 1).

export interface Balance { name: string; net: number }
export interface Transfer { from: string; to: string; amount: number }

export const MAX_EXACT = 16;

/** Settle balances that add up to zero. Throws if they don't. */
export function settle(balances: readonly Balance[]): Transfer[] {
  const total = balances.reduce((a, b) => a + b.net, 0);
  if (total !== 0) throw new Error(`balances add up to ${total}, not 0`);
  const people = balances.filter(b => b.net !== 0);
  if (people.length > MAX_EXACT) return greedy(people);
  const n = people.length, full = (1 << n) - 1;
  const sum = new Array<number>(1 << n).fill(0);
  for (let m = 1; m <= full; m++) { const low = m & -m; sum[m] = sum[m ^ low]! + people[31 - Math.clz32(low)]!.net; }
  // best[m] = the most zero-sum groups that the people in m can be split into, taking people in some order
  const best = new Array<number>(1 << n).fill(0);
  for (let m = 1; m <= full; m++) {
    let b = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) b = Math.max(b, best[m ^ (1 << i)]!);
    best[m] = b + (sum[m] === 0 ? 1 : 0);
  }
  // walk back to recover the groups, then settle each group greedily (k - 1 transfers each)
  const groups: Balance[][] = [];
  let m = full, current: Balance[] = [];
  while (m) {
    let pick = -1;
    for (let i = 0; i < n && pick < 0; i++) if (m & (1 << i) && best[m] === best[m ^ (1 << i)]! + (sum[m] === 0 ? 1 : 0)) pick = i;
    if (sum[m] === 0 && current.length) { groups.push(current); current = []; }
    current.push(people[pick]!);
    m ^= 1 << pick;
  }
  if (current.length) groups.push(current);
  return groups.flatMap(greedy);
}

/** Largest debtor pays largest creditor until everyone is square (at most n - 1 transfers). */
export function greedy(group: readonly Balance[]): Transfer[] {
  const owe = group.filter(b => b.net < 0).map(b => ({ name: b.name, left: -b.net })).sort((a, b) => b.left - a.left);
  const get = group.filter(b => b.net > 0).map(b => ({ name: b.name, left: b.net })).sort((a, b) => b.left - a.left);
  const out: Transfer[] = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const amount = Math.min(owe[i]!.left, get[j]!.left);
    out.push({ from: owe[i]!.name, to: get[j]!.name, amount });
    owe[i]!.left -= amount;
    get[j]!.left -= amount;
    if (!owe[i]!.left) i++;
    if (!get[j]!.left) j++;
  }
  return out;
}

export interface LedgerRow { name: string; buyins: number; cashouts: number; onTable: number }
export const HOUSE = 'Computer players';
/**
 * Balances from the ledger. Chips won from or lost to the computer players make the humans'
 * balances not add up to zero; that difference is shown as the computer players' balance
 * (nobody actually pays them, and they pay nobody).
 */
export function balancesFrom(rows: readonly LedgerRow[]): Balance[] {
  // one line per name: someone who left and came back as the same player is one person
  const byName = new Map<string, number>();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + r.cashouts + r.onTable - r.buyins);
  const out = [...byName].map(([name, net]) => ({ name, net }));
  const total = out.reduce((a, b) => a + b.net, 0);
  if (total !== 0) out.push({ name: HOUSE, net: -total });
  return out;
}
