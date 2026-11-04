/* Real ink: makes the clean signature look as if a real pen wrote it.
   It reshapes the alpha of the output canvas only. Everything is sized from the pen width, so the look is the
   same at any zoom, and the noise is seeded, so the same signature always gets the same texture. */
(() => {
'use strict';

/* ---------- seeded value noise ---------- */
const NZ = new Float32Array(65536);
{ let s = 0x9e3779b9; for (let i = 0; i < NZ.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; NZ[i] = s / 4294967296; } }
function vn(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
  const a = NZ[(y0 << 8) | x0], b = NZ[(y0 << 8) | x1], c = NZ[(y1 << 8) | x0], d = NZ[(y1 << 8) | x1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => 0.65 * vn(x, y) + 0.35 * vn(x * 2.13 + 5.2, y * 2.13 + 1.3);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/* ---------- box blur (two passes of a running sum, edges repeat) ---------- */
function boxPass(src, dst, w, h, k, vertical) {
  const len = vertical ? h : w, lines = vertical ? w : h, stride = vertical ? w : 1, step = vertical ? 1 : w;
  const inv = 1 / (2 * k + 1), last = len - 1;
  for (let l = 0; l < lines; l++) {
    const base = l * step;
    let sum = 0;
    for (let i = -k; i <= k; i++) sum += src[base + (i < 0 ? 0 : i > last ? last : i) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = sum * inv;
      const add = i + k + 1 > last ? last : i + k + 1, rem = i - k < 0 ? 0 : i - k;
      sum += src[base + add * stride] - src[base + rem * stride];
    }
  }
}
function blur(src, w, h, r, tmp) {
  const k = Math.max(1, Math.round(r));
  const out = new Float32Array(src.length), t = tmp || new Float32Array(src.length);
  boxPass(src, t, w, h, k, false); boxPass(t, out, w, h, k, true);
  boxPass(out, t, w, h, k, false); boxPass(t, out, w, h, k, true);
  return out;
}

/* ---------- pens ----------
   Sizes are in pen widths. rough = edge raggedness, bleed = ink spread, base = ink density, blotch = uneven density,
   holes = tiny gaps (more in thin parts), pool = ink collecting in thick parts, thinFade = thin parts turn lighter,
   edgeDark = darker rim, halo = feathering into the paper, grain = fine paper grain. */
const PENS = {
  ballpoint: { bleed: 0.12, rough: 0.30, base: 0.93, blotch: 0.10, holes: 0.07, pool: 0.10, thinFade: 0.12, edgeDark: 0.10, halo: 0.00, grain: 0.07 },
  fountain:  { bleed: 0.20, rough: 0.16, base: 0.97, blotch: 0.08, holes: 0.00, pool: 0.40, thinFade: 0.30, edgeDark: 0.22, halo: 0.22, grain: 0.03 },
  felt:      { bleed: 0.32, rough: 0.22, base: 0.98, blotch: 0.08, holes: 0.00, pool: 0.08, thinFade: 0.04, edgeDark: 0.08, halo: 0.24, grain: 0.04 },
  aged:      { bleed: 0.18, rough: 0.46, base: 0.78, blotch: 0.26, holes: 0.16, pool: 0.12, thinFade: 0.22, edgeDark: 0.00, halo: 0.00, grain: 0.10 }
};
const CLEAN = { bleed: 0, rough: 0, base: 1, blotch: 0, holes: 0, pool: 0, thinFade: 0, edgeDark: 0, halo: 0, grain: 0 };

/* average stroke width: area / (edge length / 2) */
function penWidth(a, w, h) {
  let area = 0, edge = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (a[i] < 0.5) continue;
      area++;
      if (a[i - 1] < 0.5 || a[i + 1] < 0.5 || a[i - w] < 0.5 || a[i + w] < 0.5) edge++;
    }
  }
  return edge ? clamp(2 * area / edge, 2, 400) : 4;
}

/* canvas: the output canvas holding the clean signature in one colour. rgb: its ink colour. pen: key of PENS. amount: 0..1 */
function realInk(canvas, rgb, pen, amount) {
  const P0 = PENS[pen];
  if (!P0 || !(amount > 0)) return;
  const W = canvas.width, H = canvas.height, n = W * H;
  if (n > 12e6) return;                                  // very large: leave it clean rather than freeze the page
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, W, H), px = img.data;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = px[i * 4 + 3] / 255;
  const w = penWidth(a, W, H);

  const P = {};
  for (const k in CLEAN) P[k] = CLEAN[k] + (P0[k] - CLEAN[k]) * amount;

  const tmp = new Float32Array(n);
  const b = blur(a, W, H, Math.max(0.8, (0.06 + P.bleed) * w), tmp);          // edge shaping
  const tk = blur(a, W, H, Math.max(1.5, 0.9 * w), tmp);                      // how thick the stroke is around each pixel
  const bh = P.halo > 0.004 ? blur(a, W, H, Math.max(1.5, 0.5 * w), tmp) : null;

  const th = 0.45, soft = 0.28;
  const ec = 1 / Math.max(1.5, 0.5 * w), bc = 1 / Math.max(6, 4 * w), hc = 1 / Math.max(1.2, 0.2 * w), gc = 1 / Math.max(1, 0.07 * w);
  const [ir, ig, ib] = rgb;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, j = i * 4;
      const bv = b[i], hv = bh ? bh[i] : 0;
      if (bv < 0.02 && hv < 0.02) { px[j + 3] = 0; continue; }

      const tv = tk[i];
      const pool = smooth((tv - 0.45) / 0.4);          // thick parts, where ink collects
      const thin = smooth((0.5 - tv) / 0.3);            // hairlines and tapered ends

      // ragged edge
      const ne = fbm(x * ec, y * ec);
      const v = clamp((bv - th + (ne - 0.5) * P.rough * 1.7) / soft + 0.5, 0, 1);

      // ink density
      let d = P.base + (fbm(x * bc + 31.7, y * bc + 8.3) - 0.5) * 2 * P.blotch;
      d -= P.thinFade * thin;
      d += (1 - d) * pool * Math.min(1, P.pool * 2.2);
      if (P.holes > 0) {
        const hn = fbm(x * hc + 71.1, y * hc + 19.9);
        d *= 1 - 0.92 * smooth((hn - (0.9 - P.holes * 1.15 - P.holes * 1.3 * thin)) / 0.06);
      }
      if (P.grain > 0) d *= 1 - P.grain + P.grain * 2 * vn(x * gc + 3.3, y * gc + 12.9);
      d = clamp(d, 0, 1);

      let al = v * d;
      if (hv > 0.02) {                                   // ink feathering into the paper
        const f = P.halo * clamp(hv * 1.7, 0, 1) * (0.35 + 0.65 * vn(x * hc * 1.7 + 9.1, y * hc * 1.7 + 4.4)) * (1 - v);
        al = al + f * (1 - al);
      }
      if (al < 0.004) { px[j + 3] = 0; continue; }

      // colour: darker where ink pools and along the rim
      const rim = v > 0 && v < 1 ? 1 - Math.abs(2 * v - 1) : 0;
      const dark = 1 - clamp(P.pool * 0.55 * pool + P.edgeDark * (0.4 + rim), 0, 0.45);
      px[j] = ir * dark; px[j + 1] = ig * dark; px[j + 2] = ib * dark;
      px[j + 3] = al * 255 + 0.5;
    }
  }
  ctx.putImageData(img, 0, 0);
}

window.SX = window.SX || {};
window.SX.realInk = realInk;
window.SX.pens = Object.keys(PENS);
})();
