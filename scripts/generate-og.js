// Generates public/og.png — the social link-preview card (1200×630) shown when
// the site is shared on WhatsApp/Telegram/X/Facebook etc. Rendered in the app's
// "Amber overdrive" departure-board style from scripts/og-template.html.
//
// There is no build step in this project, so the PNG this produces is committed
// to public/ and served statically (referenced by og:image / twitter:image in
// index.html). Re-run after editing the template with:
//   npm run og
//
// Renders the HTML with headless Google Chrome at 2× (for crisp dot-matrix text)
// then downscales to exactly 1200×630 with sharp. Requires Chrome/Chromium —
// set CHROME_BIN if it's not in a standard location.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const W = 1200, H = 630;
const TEMPLATE = path.join(__dirname, 'og-template.html');
const OUT = path.join(__dirname, '..', 'public', 'og.png');

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN to the browser binary.');
}

(async () => {
  const chrome = findChrome();
  const tmp = path.join(os.tmpdir(), `buski-og-${Date.now()}.png`);

  // Chrome's built-in headless screenshot. --force-device-scale-factor=2 renders
  // at 2400×1260; --virtual-time-budget lets the web fonts load before capture.
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=2', `--window-size=${W},${H}`,
    '--virtual-time-budget=6000', '--run-all-compositor-stages-before-draw',
    '--default-background-color=0c0705ff',
    `--screenshot=${tmp}`, `file://${TEMPLATE}`,
  ], { stdio: 'ignore' });

  await sharp(tmp).resize(W, H, { fit: 'fill' }).png({ compressionLevel: 9 }).toFile(OUT);
  fs.rmSync(tmp, { force: true });
  console.log(`✓ og.png (${W}×${H}) → ${path.relative(process.cwd(), OUT)}`);
})().catch(err => { console.error(err); process.exit(1); });
