// Generates the PWA / home-screen icons from the Buski bus mark.
//
// There is no build step in this project, so the PNGs this produces are
// committed to public/icons and served statically. Re-run with:
//   npm run icons
//
// Requires `sharp` (already a dependency).

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

const RED = '#d32f2f';

// The Buski bus, drawn in a 96×96 coordinate space (same paths as the favicon
// in index.html). Returned as a group so it can be scaled/centred per icon.
function busGroup() {
  return `
    <g>
      <rect x="16" y="40" width="4" height="11" rx="2" fill="${RED}"/>
      <rect x="76" y="40" width="4" height="11" rx="2" fill="${RED}"/>
      <rect x="18" y="20" width="60" height="50" rx="13" fill="${RED}"/>
      <rect x="24" y="29" width="21" height="17" rx="4.5" fill="#fff"/>
      <rect x="51" y="29" width="21" height="17" rx="4.5" fill="#fff"/>
      <circle cx="35" cy="38" r="3.4" fill="${RED}"/>
      <circle cx="62" cy="38" r="3.4" fill="${RED}"/>
      <path d="M40 56 q8 6.5 16 0" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>
      <rect x="27" y="67" width="11" height="8" rx="3" fill="#3a3a3a"/>
      <rect x="58" y="67" width="11" height="8" rx="3" fill="#3a3a3a"/>
    </g>`;
}

// Build an SVG of `size`px with a white background and the bus centred,
// occupying `frac` of the canvas. `rounded` controls the corner radius
// (fraction of size) — 0 gives a full-bleed square for maskable/apple icons.
function iconSvg(size, { frac = 0.82, rounded = 0.22 } = {}) {
  const scale = (size * frac) / 96;
  const offset = (size - 96 * scale) / 2;
  const r = size * rounded;
  const bg = r > 0
    ? `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="#fff"/>`
    : `<rect x="0" y="0" width="${size}" height="${size}" fill="#fff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${bg}
    <g transform="translate(${offset} ${offset}) scale(${scale})">${busGroup()}</g>
  </svg>`;
}

// name → { size, opts }. Maskable & apple use a full-bleed square (the OS
// applies its own mask/rounding); maskable keeps the mark inside the ~80%
// safe zone so it is never clipped.
const ICONS = {
  'icon-192.png':          { size: 192, opts: { frac: 0.82, rounded: 0.22 } },
  'icon-512.png':          { size: 512, opts: { frac: 0.82, rounded: 0.22 } },
  'icon-maskable-512.png': { size: 512, opts: { frac: 0.60, rounded: 0 } },
  'apple-touch-icon.png':  { size: 180, opts: { frac: 0.80, rounded: 0 } },
  'favicon-32.png':        { size: 32,  opts: { frac: 0.86, rounded: 0.22 } },
};

(async () => {
  for (const [name, { size, opts }] of Object.entries(ICONS)) {
    const svg = Buffer.from(iconSvg(size, opts));
    await sharp(svg, { density: 384 }).png().toFile(path.join(OUT_DIR, name));
    console.log(`✓ ${name} (${size}×${size})`);
  }
  console.log('Done → public/icons');
})().catch(err => { console.error(err); process.exit(1); });
