// The Big Bucks mark: a tall, lean antique-gold bucket with a trophy buck cut out of it and gold
// dark green bills rising from the top, on a dark charcoal tile: muted gold, charcoal and dark green
// only, so it stays dark and reads as one bold shape at every size. Single source for the app icons (generate-icons.mjs) and
// public/icons/mark.svg, which the in-app <Mark> renders.

export const GOLD = "#C9A24A";
export const DARK = "#111114";
export const BILL = "#1F5A3A";
export const BILL_INK = "#9BC7A8";

// Buck head, front view, in local coords (x centered on 0, antler tips at y≈-110, muzzle at y≈180).
const BUCK = [
  "M-24 44 L24 44 L33 60 L29 96 L17 142 L9 170 L0 180 L-9 170 L-17 142 L-29 96 L-33 60 Z",
  "M-22 58 C -40 34 -66 22 -80 -4 C -92 -28 -88 -62 -64 -108 C -74 -64 -76 -34 -64 -14 C -52 6 -28 20 -2 52 Z",
  "M-24.633436854000504 29.316718427000254 L-44 4 L-35.36656314599949 34.683281572999746 Z",
  "M-47.01912571880304 16.517101798607182 L-50 -38 L-60.98087428119696 15.482898201392818 Z",
  "M-65.15538310145813 -4.533296378883886 L-60 -62 L-78.84461689854187 -7.466703621116114 Z",
  "M-78.69049066570811 -42.79447859699573 L-104 -78 L-89.30950933429189 -37.20552140300427 Z",
  "M-27 60 L-50 50 L-76 38 L-64 58 L-32 82 Z",
  "M22 58 C 40 34 66 22 80 -4 C 92 -28 88 -62 64 -108 C 74 -64 76 -34 64 -14 C 52 6 28 20 2 52 Z",
  "M24.633436854000504 29.316718427000254 L44 4 L35.36656314599949 34.683281572999746 Z",
  "M47.01912571880304 16.517101798607182 L50 -38 L60.98087428119696 15.482898201392818 Z",
  "M65.15538310145813 -4.533296378883886 L60 -62 L78.84461689854187 -7.466703621116114 Z",
  "M78.69049066570811 -42.79447859699573 L104 -78 L89.30950933429189 -37.20552140300427 Z",
  "M27 60 L50 50 L76 38 L64 58 L32 82 Z",
];

// A bill peeking out of the bucket: dark green card edged in the tile color, with a muted green "$".
const bill = (cx, cy, rot) => `
  <g transform="translate(${cx} ${cy}) rotate(${rot})">
    <rect x="-46" y="-70" width="92" height="140" rx="7" fill="${BILL}" stroke="${DARK}" stroke-width="8"/>
    <rect x="-33" y="-57" width="66" height="114" rx="4" fill="none" stroke="${BILL_INK}" stroke-width="3" stroke-opacity=".45"/>
    <path d="M9 -34 C 3 -40 -12 -40 -12 -30 C -12 -19 11 -24 11 -12 C 11 -3 -4 -2 -11 -8 M0 -46 V 6" fill="none" stroke="${BILL_INK}" stroke-width="7" stroke-linecap="round"/>
  </g>`;

/**
 * @param {{ size?: number, rounded?: boolean, scale?: number, tile?: boolean }} o
 *   rounded: rounded-square tile (false = full-bleed square for maskable / iOS)
 *   scale: glyph scale around the center (maskable icons need the glyph inside the 80% safe zone)
 */
export function bucketsMark({ size = 512, rounded = true, scale = 1, tile = true } = {}) {
  const bg = !tile ? "" : `<rect width="512" height="512" ${rounded ? "rx=\"116\"" : ""} fill="url(#tile)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B1B20"/><stop offset="1" stop-color="${DARK}"/></linearGradient>
  </defs>
  ${bg}
  <g transform="translate(256 270) scale(${scale}) translate(-256 -270)">
    <path d="M140 226 C 128 96 384 96 372 226" fill="none" stroke="${GOLD}" stroke-width="14" stroke-linecap="round"/>
    ${bill(214, 168, -14)}${bill(300, 164, 13)}${bill(257, 148, -1)}
    <path d="M148 222 H364 L336 440 Q334 458 316 458 H196 Q178 458 176 440 Z" fill="${GOLD}"/>
    <path d="M158 268 H354" stroke="${DARK}" stroke-width="6" stroke-opacity=".55"/>
    <rect x="128" y="198" width="256" height="32" rx="10" fill="${GOLD}" stroke="${DARK}" stroke-width="7"/>
    <circle cx="146" cy="214" r="7" fill="${DARK}"/><circle cx="366" cy="214" r="7" fill="${DARK}"/>
    <g transform="translate(256 362) scale(0.6) translate(0 -36)" fill="${DARK}">
      ${BUCK.map((p) => `<path d="${p}"/>`).join("")}
    </g>
  </g>
</svg>`;
}
