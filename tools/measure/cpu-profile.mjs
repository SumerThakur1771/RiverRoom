// Diagnostic CPU profile of a Hold'em session (used to find where the long tasks came from).
// Prints inclusive and self time per function from a DevTools-protocol sampling profile.
// Usage: node tools/measure/cpu-profile.mjs [seconds=15]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const SECS = +(process.argv[2] || 15);
let s = readFileSync(new URL('../../legacy/river-room.html', import.meta.url), 'utf8');
s = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + s + '</body></html>';
s = s.replace('const PACE = {learn: 1, normal: 0.55, fast: 0.3};', 'const PACE = {learn: 1, normal: 0.55, fast: 0.02};')
     .replace('  const d = REDUCED ? 40 : dur * Math.min(1, SPEED() * 0.8 + 0.35);', '  const d = 5;');
const file = join(mkdtempSync(join(tmpdir(), 'rr-prof-')), 'p.html'); writeFileSync(file, s);
const b = await chromium.launch(); const ctx = await b.newContext();
await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ pace: 'fast', review: 'none', sound: false, timer: 0, mode: 'home', games: 'holdem', holdResult: false, revealAll: false, hints: true })));
const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
await p.goto('file://' + file); await p.waitForTimeout(300);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
await p.click('#startBtn');
const t0 = Date.now();
while (Date.now() - t0 < SECS * 1000) {
  if (await p.isVisible('#rebuyOv')) await p.click('#rebuyYes');
  if (await p.isVisible('#revOv')) await p.click('#rvNext');
  if (await p.isVisible('#contRow')) await p.click('#contBtn');
  if (await p.isVisible('#act')) await p.click('#bCall').catch(() => {});
  await p.waitForTimeout(25);
}
const { profile } = await cdp.send('Profiler.stop'); await b.close();
const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map(), self = new Map(), key = f => `${f.functionName || '(anonymous)'}:${f.lineNumber + 1}`;
for (let i = 0; i < profile.samples.length; i++) {
  const dt = (profile.timeDeltas[i + 1] || 0) / 1000; let id = profile.samples[i]; const seen = new Set();
  const lk = key(byId.get(id).callFrame); self.set(lk, (self.get(lk) || 0) + dt);
  while (id) { const k = key(byId.get(id).callFrame); if (!seen.has(k)) { incl.set(k, (incl.get(k) || 0) + dt); seen.add(k); } id = parent.get(id); }
}
const top = mp => [...mp].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join('\n');
console.log(`Line numbers are in the wrapped page (legacy line + 0; the wrapper adds no lines before the script).\nINCLUSIVE\n${top(incl)}\nSELF\n${top(self)}`);
