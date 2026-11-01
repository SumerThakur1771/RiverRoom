// Multiplayer client: lobby, table and actions. Everything shown comes from the server's
// per-seat view; the client never holds other players' hidden cards.
import { io, type Socket } from 'socket.io-client';
import type { Ack, LogLine, View } from '../../server/src/protocol';
import { HOUSE, type Balance, type Transfer } from '../ledger/settle';
import { initSite } from '../pwa/site';

initSite();

const SERVER = (import.meta.env.VITE_MP_SERVER_URL as string | undefined) || 'http://localhost:8080';
const KEY = 'river-room-mp';
const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT = ['♠', '♥', '♦', '♣'];
const SUIT_NAME = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANK_NAME = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const money = (cents: number): string => '$' + (cents / 100).toFixed(2);
const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cardHtml = (c: number): string => {
  const r = c >> 2, s = c & 3;
  return `<span class="card${s === 1 || s === 2 ? ' r' : ''}" role="img" aria-label="${RANK_NAME[r]} of ${SUIT_NAME[s]}">${RANK[r]}${SUIT[s]}</span>`;
};
const backs = (n: number): string => '<span class="card back" aria-hidden="true"></span>'.repeat(n);

interface Saved { code: string; token: string; name: string }
const load = (): Saved | null => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') as Saved | null; } catch { return null; } };
const save = (s: Saved | null): void => { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

const sock: Socket = io(SERVER, { transports: ['websocket'], autoConnect: true });
let view: View | null = null;
let session = load();
let countdown: number | undefined;

/*
 * The game server runs on a free host that sleeps after 15 minutes without players, and
 * takes about a minute to wake. While the first connection is pending (after a short grace
 * period, so a server that is already awake shows nothing) the page says so, and lobby
 * actions wait for the connection instead of failing.
 */
const WAKE_NOTICE_MS = 1500, WAKE_LIMIT_MS = 120_000, pageStart = Date.now();
let everConnected = false;
const waking = (on: boolean): void => {
  $('wake').hidden = !on;
  if (on) $('conn').textContent = 'Waking up the server…';
};
const wakeTimer = window.setTimeout(() => { if (!sock.connected) waking(true); }, WAKE_NOTICE_MS);
/** Resolves true once connected (at once if already), false after `ms`. */
function connected(ms: number): Promise<boolean> {
  if (sock.connected) return Promise.resolve(true);
  return new Promise(resolve => {
    const on = (): void => { clearTimeout(t); resolve(true); };
    const t = window.setTimeout(() => { sock.off('connect', on); resolve(false); }, ms);
    sock.once('connect', on);
  });
}

async function call<T extends { ok: true } | { ok: false; error: string } = Ack>(ev: string, msg: unknown): Promise<T> {
  const noAnswer = { ok: false, error: 'no answer from the server' } as unknown as T;
  if (!(await connected(everConnected ? 8000 : WAKE_LIMIT_MS))) return noAnswer;
  return new Promise(resolve => sock.timeout(8000).emit(ev, msg, (err: Error | null, ack: T) => resolve(err ? noAnswer : ack)));
}

/* ---- lobby ---- */
const params = new URLSearchParams(location.search);
if (params.get('code')) $<HTMLInputElement>('code').value = params.get('code')!.toUpperCase();
$<HTMLInputElement>('name').value = session?.name ?? '';
function lobbyError(e: string): void { $('lobbyErr').textContent = e; }
async function enter(kind: 'create' | 'join'): Promise<void> {
  const name = $<HTMLInputElement>('name').value.trim(), code = $<HTMLInputElement>('code').value.trim().toUpperCase();
  if (!name) return lobbyError('Type your name first.');
  if (kind === 'join' && !/^[A-Z2-9]{6}$/.test(code)) return lobbyError('A table code has 6 letters and numbers.');
  lobbyError('');
  for (const b of ['create', 'join']) $<HTMLButtonElement>(b).disabled = true;
  const ack = await call(kind, kind === 'create' ? { name } : { code, name }).finally(() => { for (const b of ['create', 'join']) $<HTMLButtonElement>(b).disabled = false; });
  if (!ack.ok) return lobbyError(ack.error === 'no such room' ? 'No table with that code. Check it with your friend.' : ack.error === 'the table is full' ? 'That table is full.' : 'Could not join: ' + ack.error);
  session = { code: ack.code!, token: ack.token!, name };
  save(session);
  history.replaceState(null, '', `?code=${ack.code}`);
}
$('create').onclick = () => void enter('create');
$('join').onclick = () => void enter('join');

/* ---- connection and reconnection ---- */
sock.on('connect', async () => {
  everConnected = true;
  clearTimeout(wakeTimer);
  waking(false);
  $('conn').textContent = 'Connected';
  if (session && !view) {
    const ack = await call('resume', { code: session.code, token: session.token });
    if (!ack.ok) { session = null; save(null); }
  } else if (session && view) await call('resume', { code: session.code, token: session.token });
});
sock.on('disconnect', () => { $('conn').textContent = 'Reconnecting…'; });
sock.on('connect_error', () => {
  // the client keeps retrying; while a sleeping server may still be waking, keep saying so
  if (!everConnected && Date.now() - pageStart < WAKE_LIMIT_MS) { waking(true); return; }
  waking(false);
  $('conn').textContent = 'Cannot reach the game server';
});
sock.on('state', (v: View) => { view = v; render(); });
sock.on('log', (l: LogLine) => {
  const li = document.createElement('li');
  li.textContent = l.text;
  const ol = $('log');
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild!.remove();
});

/* ---- table ---- */
function render(): void {
  const v = view;
  if (!v) return;
  $('lobby').hidden = true;
  $('table').hidden = false;
  $('tcode').textContent = v.code;
  $('pot').textContent = money(v.pot);
  $('board').innerHTML = v.board.map(cardHtml).join('');
  $('msg').textContent = v.msg;
  const me = v.seats[v.you]!;
  $('mine').innerHTML = me.cards ? me.cards.map(cardHtml).join('') : '';
  $('seats').innerHTML = v.seats.map(s => {
    const turn = v.turn?.seat === s.seat, dealer = v.button === s.seat;
    const status = s.kind === 'bot' ? 'computer' : s.connected ? '' : 'away';
    const cards = s.seat === v.you ? '' : s.cards ? `<div class="cards sm">${s.cards.map(cardHtml).join('')}</div>` : s.cardCount && !s.folded ? `<div class="cards sm">${backs(s.cardCount)}</div>` : '';
    return `<div class="seat${turn ? ' turn' : ''}${s.folded ? ' folded' : ''}"><div class="nm">${esc(s.name)}${s.seat === v.you ? ' (you)' : ''}${dealer ? ' · D' : ''}</div>`
      + `<div class="st">${money(s.stack)}</div><div class="sm">${[s.bet ? 'bet ' + money(s.bet) : '', s.label, status, s.handName].filter(Boolean).map(esc).join(' · ')}</div>${cards}</div>`;
  }).join('');
  const t = v.turn, mine = t && t.seat === v.you && t.options;
  $('actions').hidden = !mine;
  if (mine) {
    const o = t.options!;
    $('call').textContent = o.toCall > 0 ? `Call ${money(o.toCall)}` : 'Check';
    const amt = $<HTMLInputElement>('amount');
    amt.min = String(o.minTo); amt.max = String(o.maxTo); amt.step = '10';
    if (+amt.value < o.minTo || +amt.value > o.maxTo) amt.value = String(o.minTo);
    $('raise').hidden = amt.hidden = !o.canRaise;
    updateRaiseLabel();
  }
  $('rebuy').hidden = !v.rebuy;
  clearInterval(countdown);
  const tick = (): void => {
    if (!t) { $('turn').textContent = v.phase === 'waiting' ? 'Waiting for the next hand…' : ''; return; }
    const left = Math.max(0, Math.ceil((t.deadline - Date.now()) / 1000));
    $('turn').textContent = t.seat === v.you ? `Your turn: ${left}s` : `${v.seats[t.seat]!.name} to act`;
  };
  tick();
  countdown = window.setInterval(tick, 500);
}
function updateRaiseLabel(): void {
  const o = view?.turn?.options;
  if (!o) return;
  const to = +$<HTMLInputElement>('amount').value;
  $('raise').textContent = to >= o.maxTo ? `All-in ${money(o.maxTo)}` : `${view!.currentBet ? 'Raise to' : 'Bet'} ${money(to)}`;
}
$('amount').oninput = updateRaiseLabel;
const act = (a: { type: string; to?: number }): void => { $('actions').hidden = true; void call('act', a); };
$('fold').onclick = () => act({ type: 'fold' });
$('call').onclick = () => act({ type: view?.turn?.options?.toCall ? 'call' : 'check' });
$('raise').onclick = () => act({ type: 'raise', to: +$<HTMLInputElement>('amount').value });
$('rebuyYes').onclick = () => void call('rebuy', { yes: true });
$('rebuyNo').onclick = () => void call('rebuy', { yes: false });
$('copy').onclick = () => { if (view) void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?code=${view.code}`); };

/* ---- settle up ---- */
type SettleAck = { ok: true; balances: Balance[]; transfers: Transfer[]; stored: boolean } | { ok: false; error: string };
const signed = (cents: number): string => (cents > 0 ? '+' : cents < 0 ? '−' : '') + money(Math.abs(cents));
$('settleBtn').onclick = async () => {
  const r = await call<SettleAck>('settle', {});
  const box = $('settle');
  box.hidden = false;
  if (!r.ok) { $('balances').innerHTML = ''; $('transfers').innerHTML = ''; $('settleNote').textContent = 'Could not load the settlement: ' + r.error; return; }
  $('balances').innerHTML = r.balances.map(b => `<tr><td>${esc(b.name)}</td><td class="${b.net < 0 ? 'neg' : 'pos'}">${signed(b.net)}</td></tr>`).join('');
  // chips won from or lost to the computer players are not real debts: list them, but nobody pays them
  const people = r.transfers.filter(t => t.from !== HOUSE && t.to !== HOUSE);
  const house = r.transfers.filter(t => t.from === HOUSE || t.to === HOUSE);
  $('transfers').innerHTML = people.length ? people.map(t => `<li><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b> ${money(t.amount)}</li>`).join('') : '<li>Nobody owes anybody.</li>';
  $('settleNote').textContent = [
    ...house.map(t => t.to === HOUSE ? `${t.from} lost ${money(t.amount)} to the computer players (no payment).` : `${t.to} won ${money(t.amount)} from the computer players (nobody pays this).`),
    r.stored ? 'Totals come from the saved buy-in ledger.' : 'Totals come from this table session (the server has no database configured).',
  ].join(' ');
  box.focus();
};
$('settleClose').onclick = () => { $('settle').hidden = true; };
$('leave').onclick = async () => { await call('leave', {}); session = null; save(null); view = null; location.href = location.pathname; };
