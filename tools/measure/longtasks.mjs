// Main-thread blocking during bot turns and coach hints, measured in real Chromium.
//
// Builds an instrumented copy of legacy/river-room.html in a temp folder. The copy:
//   - shortens animation/thinking waits (the waits are timers, not CPU work, so this
//     changes how many hands fit in the run, not how long each computation blocks),
//   - adds hooks to force a variant and auto-pick the hero's final split,
//   - times the synchronous part of: a bot decision (aiAction up to its think-time wait),
//     a coach hint (showHintInner), and the deal-time card planning for split games (initPlans).
// Separately, a PerformanceObserver records every browser "longtask" (>50 ms on the main thread).
//
// Usage: node tools/measure/longtasks.mjs [secondsPerVariant=60] [cpuThrottle=1]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const SECS = +(process.argv[2] || 60);
const THROTTLE = +(process.argv[3] || 1);
const VARIANTS = ['holdem', 'std', 'two', 'k8', 'n7'];

let s = readFileSync(new URL('../../legacy/river-room.html', import.meta.url), 'utf8');
function r(a, b) { if (s.split(a).length !== 2) throw new Error('anchor not unique: ' + a.slice(0, 60)); s = s.replace(a, b); }
// The artifact host wraps the page in a skeleton that includes [hidden]{display:none}; recreate it.
s = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + s + '</body></html>';
r("const PACE = {learn: 1, normal: 0.55, fast: 0.3};", "const PACE = {learn: 1, normal: 0.55, fast: 0.02};");
r("  const d = REDUCED ? 40 : dur * Math.min(1, SPEED() * 0.8 + 0.35);", "  const d = 5;");
// __rec stores every timed duration, plus start/duration of calls >= 2 ms for long-task attribution.
r("let S = null, GID = 0,", "window.__T = {}; const __rec = (k, ms) => { if (!window.__on) return; (window.__T[k] ||= []).push(ms); if (ms >= 2) (window.__C ||= []).push([k, performance.now() - ms, ms]); }; let S = null, GID = 0; window.__rr = () => S; let __x,");
r("function pickVariant(d){\n", "function pickVariant(d){\n  if (window.__force) return Promise.resolve(window.__force);\n");
r("function heroSplit(p, k, mode){\n", "function heroSplit(p, k, mode){\n  if (mode === 'final') return Promise.resolve(planSplit(p, k));\n");
// Generic timer: rename each function and put a timing wrapper in its place. For async
// functions this times only the synchronous slice before the first await, which is exactly
// the part that can block the main thread.
const TIMED = ['playHand', 'bettingRound', 'applyAction', 'setupTable', 'revealAll', 'buildPots', 'runLoop', 'pickVariant', 'coachContext', 'coachPre', 'coachPost', 'gradeDecision', 'humanAction', 'setupActionUI', 'render',
  'showdown', 'finalSplits', 'showdownMulti', 'revealEveryone', 'saveAfterHand', 'makeSnap', 'persistTable',
  'storyLines', 'buildReview', 'recordProgress', 'endOfHand', 'endStreet', 'initPlans', 'showHintInner'];
for (const name of TIMED) {
  const m = s.match(new RegExp('\\n(async )?function ' + name + '\\('));
  if (!m) throw new Error('function not found: ' + name);
  r(m[0], `\nfunction ${name}(...a){ const t0 = performance.now(); try { return __${name}.apply(this, a); } finally { __rec('${name}', performance.now() - t0); } }\n${m[1] || ''}function __${name}(`);
}
// oppDist is also a hot cache lookup (millions of calls), so time only the real computation (cache misses).
r("function oppDist(key){\n  if (OPPD[key]) return OPPD[key];\n", "function oppDist(key){\n  if (OPPD[key]) return OPPD[key];\n  const t0 = performance.now(); try { return __oppDist(key); } finally { __rec('oppDist', performance.now() - t0); }\n}\nfunction __oppDist(key){\n");
r("const coachRec = c => {","const coachRec = c => { const t0 = performance.now(); try { return __coachRec(c); } finally { __rec('coachRec', performance.now() - t0); } };\nconst __coachRec = c => {");
// bot decision: the synchronous part of aiAction up to its think-time wait
r("async function aiAction(p){\n", "async function aiAction(p){\n  const __t0 = performance.now();\n");
r("  const tt = thinkTime(p, a, o, p._eq == null ? 0.5 : p._eq);\n", "  __rec('aiAction(sync)', performance.now() - __t0);\n  const tt = thinkTime(p, a, o, p._eq == null ? 0.5 : p._eq);\n");

const dir = mkdtempSync(join(tmpdir(), 'rr-measure-'));
const file = join(dir, 'instrumented.html');
writeFileSync(file, s);

const stats = a => {
  if (!a.length) return { n: 0 };
  const x = a.slice().sort((p, q) => p - q), q = f => x[Math.min(x.length - 1, Math.floor(f * x.length))];
  return { n: x.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +x[x.length - 1].toFixed(1), over50: x.filter(v => v > 50).length };
};

const browser = await chromium.launch();
const results = [];
for (const v of VARIANTS) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('river-room-v2', JSON.stringify({ pace: 'fast', review: 'none', sound: false, timer: 0, mode: 'home', games: 'dealer', holdResult: false, revealAll: false, hints: true }));
    window.__long = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) { window.__long.push(e.duration); (window.__LT ||= []).push([e.startTime, e.duration]); } }).observe({ type: 'longtask', buffered: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (THROTTLE > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }
  await page.goto('file://' + file);
  await page.evaluate(variant => { window.__force = variant; }, v);
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForTimeout(500);
  // ignore anything that happened during page load / table setup
  await page.evaluate(() => { window.__long.length = 0; window.__LT = []; window.__C = []; window.__T = {}; window.__on = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    if (await page.isVisible('#dealOv')) await page.locator(`#dealOpts button[data-k="${v}"]`).click();
    if (await page.isVisible('#rebuyOv')) await page.click('#rebuyYes');
    if (await page.isVisible('#revOv')) await page.click('#rvNext');
    if (await page.isVisible('#contRow')) await page.click('#contBtn');
    if (await page.isVisible('#act')) {
      if (await page.isVisible('#hintBtn')) { await page.click('#hintBtn'); await page.waitForTimeout(20); if (await page.isVisible('#hint')) await page.click('#hintBtn'); }
      if (await page.isVisible('#act')) await page.click('#bCall').catch(() => {});
    }
    await page.waitForTimeout(25);
  }
  const d = await page.evaluate(() => ({ long: window.__long.slice(), T: window.__T, hands: window.__rr().handNo, LT: window.__LT || [], C: window.__C || [] }));
  // attribute each long task to the timed calls that ran inside it (outermost-first is fine for a report)
  const attrib = {};
  for (const [ls, ld] of d.LT) {
    const inside = d.C.filter(([, cs, cm]) => cs >= ls - 1 && cs + cm <= ls + ld + 1);
    const top = inside.sort((p, q) => q[2] - p[2])[0];
    const key = top ? top[0] : '(no timed function)';
    (attrib[key] ||= []).push(ld);
  }
  const fn = {}; for (const [k, arr] of Object.entries(d.T)) fn[k] = stats(arr);
  results.push({ variant: v, hands: d.hands, fn, longtasks: stats(d.long), attrib: Object.fromEntries(Object.entries(attrib).map(([k, a]) => [k, stats(a)])), errors: errors.length });
  await ctx.close();
}
await browser.close();

const ua = `Chromium ${browser.version()}`;
console.log(`Main-thread measurements, ${SECS}s per variant, CPU throttle ${THROTTLE}x, ${ua}`);
console.log('ms values: median / p95 / max  (n = samples, >50 = samples over 50 ms)');
const row = (o) => o.n ? `${String(o.median).padStart(6)} /${String(o.p95).padStart(7)} /${String(o.max).padStart(7)}  n=${String(o.n).padStart(4)} >50=${o.over50}` : '   (no samples)';
for (const x of results) {
  console.log(`\n${x.variant}  (hands played: ${x.hands}, page errors: ${x.errors})`);
  console.log(`  longtasks     : ${x.longtasks.n ? `count=${x.longtasks.n} median=${x.longtasks.median} p95=${x.longtasks.p95} max=${x.longtasks.max}` : 'none over 50 ms'}`);
  for (const [k, o] of Object.entries(x.attrib).sort((p, q) => q[1].max - p[1].max)) console.log(`    longtask in ${k.padEnd(20)}: count=${o.n} max=${o.max}`);
  const rows = Object.entries(x.fn).filter(([, o]) => o.max >= 5).sort((p, q) => q[1].max - p[1].max);
  for (const [k, o] of rows) console.log(`  ${k.padEnd(14)}: ${row(o)}`);
}
console.log('\nJSON ' + JSON.stringify(results));
