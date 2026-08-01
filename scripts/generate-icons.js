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

const TILE = '#0c0705';   // dark board tile

// The Buski "blind-bus" mark — a bus front whose face is an amber dot-matrix
// destination blind, in a 96×96 space (same paths as the favicon in index.html).
function busGroup() {
  return `
    <g>
      <rect x="20" y="15" width="56" height="66" rx="16" fill="#241610" stroke="#ff7a1f" stroke-width="3"/>
      <rect x="27" y="22" width="42" height="14" rx="3" fill="#0a0603"/>
      <circle cx="33" cy="29" r="2.3" fill="#ffc400"/>
      <circle cx="40" cy="29" r="2.3" fill="#ffc400"/>
      <circle cx="47" cy="29" r="2.3" fill="#ffc400"/>
      <circle cx="54" cy="29" r="2.3" fill="#ffc400"/>
      <circle cx="61" cy="29" r="2.3" fill="#ffc400"/>
      <rect x="27" y="42" width="42" height="15" rx="4" fill="#4a3418"/>
      <circle cx="33" cy="71" r="4" fill="#ffd21a"/>
      <circle cx="63" cy="71" r="4" fill="#ffd21a"/>
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
    ? `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="${TILE}"/>`
    : `<rect x="0" y="0" width="${size}" height="${size}" fill="${TILE}"/>`;
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

// Wrap a PNG buffer in a single-image ICO container (PNG-in-ICO, supported by
// all modern browsers + Google). Google Search's primary favicon lookup is
// /favicon.ico, so we ship a real one — a data-URI <link> icon isn't crawlable.
function pngToIco(png, size) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2);            // type = 1 (icon)
  dir.writeUInt16LE(1, 4);            // image count = 1
  const ent = Buffer.alloc(16);
  ent[0] = size >= 256 ? 0 : size;    // width  (0 means 256)
  ent[1] = size >= 256 ? 0 : size;    // height
  ent.writeUInt16LE(1, 4);            // color planes
  ent.writeUInt16LE(32, 6);           // bits per pixel
  ent.writeUInt32LE(png.length, 8);   // size of PNG data
  ent.writeUInt32LE(22, 12);          // offset = 6 (dir) + 16 (entry)
  return Buffer.concat([dir, ent, png]);
}

(async () => {
  for (const [name, { size, opts }] of Object.entries(ICONS)) {
    const svg = Buffer.from(iconSvg(size, opts));
    await sharp(svg, { density: 384 }).png().toFile(path.join(OUT_DIR, name));
    console.log(`✓ ${name} (${size}×${size})`);
  }

  // Real /favicon.ico at the site root (48×48 — Google's recommended size).
  const fav = await sharp(Buffer.from(iconSvg(48, { frac: 0.86, rounded: 0.22 })), { density: 384 }).png().toBuffer();
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'), pngToIco(fav, 48));
  console.log('✓ favicon.ico (48×48)');

  console.log('Done → public/icons + public/favicon.ico');
})().catch(err => { console.error(err); process.exit(1); });
