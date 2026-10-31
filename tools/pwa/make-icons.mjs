// Render the app icons (PNG) from public/icons/icon.svg with headless Chromium.
// Maskable icons keep the artwork inside the central 80% "safe zone".
// Usage: node tools/pwa/make-icons.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const shots = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'maskable-512.png', size: 512, pad: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0 },
];
for (const s of shots) {
  await page.setViewportSize({ width: s.size, height: s.size });
  const inner = s.size * (1 - 2 * s.pad);
  await page.setContent(`<body style="margin:0;background:#0a0e0c;display:grid;place-items:center;width:${s.size}px;height:${s.size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body>`);
  await page.screenshot({ path: `public/icons/${s.file}`, omitBackground: false });
  console.log('wrote public/icons/' + s.file);
}
await browser.close();
