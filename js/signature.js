
(() => {
'use strict';

const { $, clamp } = SX;
const toast = SX.toast;
const MAX_SIDE = 3200;   // longest side the photo is processed at
const NOISE_FLOOR = 14;  // darkness (0-255) below this counts as paper texture

const el = {
  intro: $('#intro'), drop: $('#drop'), file: $('#file'), work: $('#work'),
  srcWrap: $('#srcWrap'), srcImg: $('#srcImg'), sel: $('#sel'), clearSel: $('#clearSel'),
  out: $('#out'), outView: $('#outView'), empty: $('#empty'), undo: $('#undoErase'),
  download: $('#download'), copy: $('#copy'), again: $('#again'), sample: $('#sigSample'), steps: $('#s-steps'),
  sens: $('#sens'), soft: $('#soft'), specks: $('#specks'), pad: $('#pad'), thick: $('#thick'), thickOut: $('#thickOut'),
  sensOut: $('#sensOut'), softOut: $('#softOut'), specksOut: $('#specksOut'), padOut: $('#padOut'),
  customColor: $('#customColor'), customChip: $('#customChip'), origDot: $('#origDot'),
  svg: $('#svg'), wmNote: $('#wmNote'),
  fx: $('#fx'), fxOut: $('#fxOut'), fxAmt: $('#fxAmt'),
};

const S = {
  W: 0, H: 0, rgba: null, d: null,
  sel: null, seeds: [], ink: 'original', bg: 'transparent',
  tKey: '', tVal: 60, last: null, url: null, name: 'signature', raf: 0,
  trace: true, wmMode: 1, wm: null, fxPen: 'off',
};

/* ---------- loading the photo ---------- */
async function loadFile(file) {
  if (!file || !/^image\//.test(file.type)) {
    toast('That file is not an image. Choose a JPG or PNG photo.', true);
    return;
  }
  if (S.loading) return;
  S.loading = true;
  SX.dropBusy(el.drop, true);
  SX.progress.start();
  try { await loadPhoto(file); } finally {
    S.loading = false;
    SX.dropBusy(el.drop, false);
    SX.progress.done();
  }
}

async function loadPhoto(file) {
  await new Promise((r) => setTimeout(r, 30));
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    toast("Couldn't open that image. Try a JPG or PNG.", true);
    return;
  }
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * k));
    const H = Math.max(1, Math.round(img.naturalHeight * k));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, W, H);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, W, H);
    S.rgba = cx.getImageData(0, 0, W, H).data;
    S.W = W; S.H = H;
    buildDarkness();
  } catch (e) {
    URL.revokeObjectURL(url);
    toast('That photo is too large to process here. Try a smaller one.', true);
    return;
  }
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = url;
  S.name = (file.name || 'signature').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'signature';
  S.sel = null; S.seeds = []; S.tKey = ''; S.wm = null;
  el.srcImg.src = url;
  el.sel.hidden = true; el.clearSel.hidden = true; el.undo.hidden = true;
  render();
  SX.hideToast();
  SX.steps(el.steps, 2);
  await SX.swap(el.intro, el.work);
}

/* Darkness map: how much darker each pixel is than the paper around it.
   The paper level is estimated from the photo itself, so shadows and uneven
   light cancel out. The signature is then read from this map. */
function buildDarkness() {
  const { W, H, rgba } = S;
  const N = W * H;
  const gray = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  const f = Math.max(1, Math.floor(Math.max(W, H) / 180));
  const gw = Math.ceil(W / f), gh = Math.ceil(H / f);
  let g = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / f) * gw;
    for (let x = 0; x < W; x++) {
      const k = row + Math.floor(x / f);
      g[k] += gray[y * W + x];
      cnt[k]++;
    }
  }
  for (let k = 0; k < g.length; k++) g[k] /= cnt[k];
  g = maxFilter(g, gw, gh, 3);   // wipe out the ink, keep the paper
  g = boxBlur(g, gw, gh, 2);
  g = boxBlur(g, gw, gh, 2);

  const x0 = new Int32Array(W), x1 = new Int32Array(W), tx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const fx = clamp((x + 0.5) / f - 0.5, 0, gw - 1);
    x0[x] = Math.floor(fx); x1[x] = Math.min(gw - 1, x0[x] + 1); tx[x] = fx - x0[x];
  }
  const d = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const fy = clamp((y + 0.5) / f - 0.5, 0, gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    const r0 = y0 * gw, r1 = y1 * gw;
    for (let x = 0; x < W; x++) {
      const a = g[r0 + x0[x]] * (1 - tx[x]) + g[r0 + x1[x]] * tx[x];
      const b = g[r1 + x0[x]] * (1 - tx[x]) + g[r1 + x1[x]] * tx[x];
      const bg = Math.max(10, a * (1 - ty) + b * ty);
      const v = 1 - gray[y * W + x] / bg;
      d[y * W + x] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
  }
  S.d = d;
}

function maxFilter(a, w, h, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -1;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; const v = a[y * w + xx]; if (v > m) m = v; }
    t[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -1;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; const v = t[yy * w + x]; if (v > m) m = v; }
    o[y * w + x] = m;
  }
  return o;
}
function boxBlur(a, w, h, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; s += a[y * w + xx]; n++; }
    t[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; s += t[yy * w + x]; n++; }
    o[y * w + x] = s / n;
  }
  return o;
}

/* ---------- crop + threshold ---------- */
function cropRect() {
  const s = S.sel;
  if (!s) return { x: 0, y: 0, w: S.W, h: S.H };
  const x = clamp(Math.floor(s.x0 * S.W), 0, S.W - 1);
  const y = clamp(Math.floor(s.y0 * S.H), 0, S.H - 1);
  const w = clamp(Math.ceil(s.x1 * S.W) - x, 1, S.W - x);
  const h = clamp(Math.ceil(s.y1 * S.H) - y, 1, S.H - y);
  return { x, y, w, h };
}

/* Otsu split between faint and solid ink, ignoring paper texture and any
   watermark marks, so a watermark cannot pull the line weight around. */
function autoThreshold(c, wm) {
  const key = wm.key;
  if (S.tKey === key) return S.tVal;
  const hist = new Uint32Array(256);
  const D = S.d, W = S.W, mask = wm.skip;
  for (let y = 0; y < c.h; y++) {
    let i = (c.y + y) * W + c.x, m = y * c.w;
    if (mask) { for (let x = 0; x < c.w; x++, i++, m++) if (!mask[m]) hist[D[i]]++; }
    else for (let x = 0; x < c.w; x++) hist[D[i++]]++;
  }
  const t0 = NOISE_FLOOR;
  let total = 0, sum = 0;
  for (let t = t0; t < 256; t++) { total += hist[t]; sum += t * hist[t]; }
  let T = 60;
  if (total >= 40) {
    let wB = 0, sumB = 0, best = -1;
    for (let t = t0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; T = t; }
    }
  }
  S.tKey = key; S.tVal = clamp(T, wm.ref ? Math.max(20, Math.round(wm.ref * 0.3)) : 20, 170);
  return S.tVal;
}

/* ---------- watermark removal ---------- */
/* A watermark, stamp or camera overlay is not pen: it is usually lighter than the
   pen, or another colour. Each connected mark is compared with the pen's own
   darkness and colour, and the marks that do not match are left out. A mark that
   matches the pen is never touched, so the strokes keep their shape and weight.
   Returns a mask over the crop (1 = not signature). */
function detectWatermark(c, mode) {
  const key = c.x + ',' + c.y + ',' + c.w + ',' + c.h + '|' + mode;
  if (S.wm && S.wm.key === key) return S.wm;
  const out = { key, mask: null, skip: null, removed: 0, ref: 0 };
  S.wm = out;
  if (!mode) return out;
  const { w, h } = c, W = S.W, D = S.d, P = S.rgba, n = w * h;

  // how dark is the pen: the darkness reached by the darkest half percent of marked pixels
  const hist = new Uint32Array(256);
  let tot = 0;
  for (let y = 0; y < h; y++) {
    let i = (c.y + y) * W + c.x;
    for (let x = 0; x < w; x++) { const v = D[i++]; if (v > NOISE_FLOOR) { hist[v]++; tot++; } }
  }
  if (tot < 80) return out;
  const want = Math.max(60, Math.round(tot * 0.005));
  let acc = 0, ref = 255;
  for (let v = 255; v > NOISE_FLOOR; v--) { acc += hist[v]; if (acc >= want) { ref = v; break; } }
  if (ref < 60) return out;
  out.ref = ref;

  // the pen's colour, as chromaticity so brightness does not matter
  let pr = 0, pg = 0, pb = 0, pn = 0;
  for (let y = 0; y < h; y++) {
    let i = (c.y + y) * W + c.x;
    for (let x = 0; x < w; x++, i++) {
      if (D[i] >= ref) { const j = i * 4; pr += P[j]; pg += P[j + 1]; pb += P[j + 2]; pn++; }
    }
  }
  const ps = pr + pg + pb + 1;
  const pcx = pr / ps, pcy = pg / ps;

  const floor = Math.max(NOISE_FLOOR + 2, Math.round(ref * 0.15));
  const kw = mode === 2 ? 0.5 : 0.4;       // a mark whose core is lighter than this share of the pen is a watermark
  const ht = mode === 2 ? 0.13 : 0.16;     // or one whose colour is this far from the pen's
  const bigMark = 60 * Math.pow(Math.max(w, h) / 1000, 2);   // marks smaller than this are specks, not worth reporting
  const seen = new Uint8Array(n), q = new Int32Array(n), mask = new Uint8Array(n), skip = new Uint8Array(n);
  const hc = new Uint32Array(256), hr = new Float64Array(256), hg = new Float64Array(256), hb = new Float64Array(256);
  let removed = 0;
  let kx0 = w, ky0 = h, kx1 = -1, ky1 = -1;

  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0]) continue;
    const sy = (s0 / w) | 0, sx = s0 - sy * w;
    if (D[(c.y + sy) * W + c.x + sx] < floor) continue;
    let head = 0, tail = 0;
    q[tail++] = s0; seen[s0] = 1;
    hc.fill(0); hr.fill(0); hg.fill(0); hb.fill(0);
    let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
    while (head < tail) {
      const p = q[head++];
      const py = (p / w) | 0, px = p - py * w;
      const gi = (c.y + py) * W + c.x + px, v = D[gi], j = gi * 4;
      hc[v]++; hr[v] += P[j]; hg[v] += P[j + 1]; hb[v] += P[j + 2];
      if (px < cx0) cx0 = px; if (px > cx1) cx1 = px; if (py < cy0) cy0 = py; if (py > cy1) cy1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx; if (nx < 0 || nx >= w) continue;
          const nn = ny * w + nx;
          if (seen[nn] || D[(c.y + ny) * W + c.x + nx] < floor) continue;
          seen[nn] = 1; q[tail++] = nn;
        }
      }
    }
    // darkness of the mark's core: the mean of its darkest tenth
    let take = Math.max(1, Math.round(tail * 0.1)), got = 0, sum = 0;
    for (let v = 255; v >= 0 && got < take; v--) {
      const k = Math.min(hc[v], take - got);
      got += k; sum += k * v;
    }
    const core = sum / got;
    // colour of its darkest quarter
    take = Math.max(1, Math.round(tail * 0.25)); got = 0;
    let rr = 0, gg = 0, bb = 0;
    for (let v = 255; v >= 0 && got < take; v--) {
      if (!hc[v]) continue;
      const f = Math.min(1, (take - got) / hc[v]);
      rr += hr[v] * f; gg += hg[v] * f; bb += hb[v] * f; got += hc[v] * f;
    }
    const cs = rr + gg + bb + 1;
    const dist = Math.hypot(rr / cs - pcx, gg / cs - pcy);
    const faint = core < kw * ref;
    const offHue = tail >= 40 && dist > ht;
    if (faint || offHue) {
      const big = tail >= bigMark;
      if (big) removed++;
      for (let k = 0; k < tail; k++) {
        const p = q[k], py = (p / w) | 0, px = p - py * w;
        if (big) skip[p] = 1;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const nx = px + dx; if (nx >= 0 && nx < w) mask[ny * w + nx] = 1; }
        }
      }
    } else {
      if (cx0 < kx0) kx0 = cx0; if (cy0 < ky0) ky0 = cy0; if (cx1 > kx1) kx1 = cx1; if (cy1 > ky1) ky1 = cy1;
    }
  }

  // a watermark that crosses the signature joins it into one mark. Its faint pixels
  // far from any pen-dark pixel are watermark, so they are left out too.
  let fringe = 0;
  if (kx1 >= 0) {
    const bw = kx1 - kx0 + 1, bh = ky1 - ky0 + 1;
    const solid = new Uint8Array(bw * bh);
    const sol = Math.round(ref * (mode === 2 ? 0.62 : 0.5));
    for (let y = 0; y < bh; y++) {
      let gi = (c.y + ky0 + y) * W + c.x + kx0;
      for (let x = 0; x < bw; x++, gi++) if (D[gi] >= sol && !mask[(ky0 + y) * w + kx0 + x]) solid[y * bw + x] = 1;
    }
    // a coloured mark that crosses the signature: pixels dark enough to judge whose colour is far
    // from anything between the pen's colour and neutral paper
    const hp = mode === 2 ? 0.09 : 0.12, hmin = Math.round(ref * 0.35);
    const vx = 1 / 3 - pcx, vy = 1 / 3 - pcy, vl = vx * vx + vy * vy;
    const hue = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      let gi = (c.y + ky0 + y) * W + c.x + kx0;
      for (let x = 0; x < bw; x++, gi++) {
        if (D[gi] < hmin || mask[(ky0 + y) * w + kx0 + x]) continue;
        const j = gi * 4, sm = P[j] + P[j + 1] + P[j + 2] + 1;
        const cx = P[j] / sm, cy = P[j + 1] / sm;
        let t = vl > 1e-6 ? ((cx - pcx) * vx + (cy - pcy) * vy) / vl : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(cx - (pcx + t * vx), cy - (pcy + t * vy)) > hp) hue[y * bw + x] = 1;
      }
    }
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        if (!hue[y * bw + x]) continue;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) k += hue[(y + dy) * bw + x + dx];
        if (k < 5) continue;       // a stray pixel, not a coloured mark
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const m = (ky0 + y + dy) * w + kx0 + x + dx;
          if (!mask[m]) { mask[m] = 1; skip[m] = 1; fringe++; }
        }
      }
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[(ky0 + y) * w + kx0 + x]) solid[y * bw + x] = 0;
    const d2 = edtSq(solid, bw, bh);
    const reach = Math.max(mode === 2 ? 2 : 3, Math.round((mode === 2 ? 0.003 : 0.005) * Math.max(w, h)));
    const r2 = reach * reach;
    for (let y = 0; y < bh; y++) {
      let gi = (c.y + ky0 + y) * W + c.x + kx0;
      for (let x = 0; x < bw; x++, gi++) {
        const m = (ky0 + y) * w + kx0 + x;
        if (!solid[y * bw + x] && !mask[m] && D[gi] >= floor && d2[y * bw + x] > r2) { mask[m] = 1; skip[m] = 1; fringe++; }
      }
    }
  }

  out.mask = mask;
  // leave the histogram alone unless a real watermark was found, so a clean photo gives the same line weight as with removal off
  out.skip = removed || fringe > bigMark * 4 ? skip : null;
  out.removed = removed + (fringe > bigMark * 4 ? 1 : 0);
  return out;
}

/* Drop connected blobs that are too small to be handwriting, and any blob
   the user clicked to erase. */
function cleanComponents(A, w, h, minArea, seeds) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  const hasSeeds = seeds.size > 0;
  for (let s = 0; s < N; s++) {
    if (!A[s] || seen[s]) continue;
    let head = 0, tail = 0, hit = false;
    q[tail++] = s; seen[s] = 1;
    while (head < tail) {
      const p = q[head++];
      if (hasSeeds && seeds.has(p)) hit = true;
      const px = p % w, py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx; if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (A[n] && !seen[n]) { seen[n] = 1; q[tail++] = n; }
        }
      }
    }
    if (hit || tail < minArea) for (let i = 0; i < tail; i++) A[q[i]] = 0;
  }
}

/* ---------- line thickness ---------- */
/* Squared distance from every pixel to the nearest pixel where src is 1. */
function edtSq(src, w, h) {
  const INF = 1e9;
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = src[i] ? 0 : INF;
  const n = Math.max(w, h);
  const line = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let sx = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sx <= z[k]) { k--; sx = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = sx; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + line[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = f[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) f[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = f[row + x];
    pass(w);
    for (let x = 0; x < w; x++) f[row + x] = d[x];
  }
  return f;
}

/* Grow (r > 0) or shrink (r < 0) the pen line by r pixels on each side,
   keeping the soft anti-aliased edge. R is the alpha of the strokes. */
function thicken(R, w, h, r) {
  const n = w * h;
  const M = new Uint8Array(n);
  for (let i = 0; i < n; i++) M[i] = R[i] >= 128 ? 1 : 0;
  const B = new Uint8Array(n);
  if (r > 0) {
    const d2 = edtSq(M, w, h);
    const reach = (r + 1) * (r + 1);
    for (let i = 0; i < n; i++) {
      const a = R[i];
      if (M[i]) { const v = a + r * 255; B[i] = v > 255 ? 255 : v; continue; }
      if (d2[i] > reach) { B[i] = a; continue; }
      const f = (1 + r - Math.sqrt(d2[i])) * 255;
      const g = f <= 0 ? 0 : f >= 255 ? 255 : f;
      B[i] = a > g ? a : g;
    }
  } else {
    const NM = new Uint8Array(n);
    for (let i = 0; i < n; i++) NM[i] = M[i] ^ 1;
    const d2 = edtSq(NM, w, h);
    for (let i = 0; i < n; i++) {
      const a = R[i];
      if (!M[i]) { const v = a + r * 255; B[i] = v > 0 ? v : 0; continue; }
      const v = (Math.sqrt(d2[i]) + r - (1 - a / 255)) * 255;
      const g = v <= 0 ? 0 : v >= 255 ? 255 : v;
      B[i] = a < g ? a : g;
    }
  }
  return B;
}

/* ---------- trace: redraw the strokes as smooth outlines ---------- */
/* The stroke coverage is turned into closed outlines (marching squares at 40% coverage,
   which keeps the pen's own line weight), thinned to the points that matter and joined
   with smooth curves. The outlines are then drawn at a larger size, so edges are crisp
   instead of made of photo pixels. */

function simplifyLoop(pts, eps) {
  const n = pts.length / 2;
  if (n < 8) return pts;
  // split the loop at its two farthest-apart points so each half is an open line
  let far = 0, fd = -1;
  for (let k = 1; k < n; k++) {
    const dx = pts[2 * k] - pts[0], dy = pts[2 * k + 1] - pts[1], d = dx * dx + dy * dy;
    if (d > fd) { fd = d; far = k; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = 1; keep[far] = 1; keep[n] = 1;
  const X = (k) => pts[2 * (k % n)], Y = (k) => pts[2 * (k % n) + 1];
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let md = -1, mi = -1;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs(dx * (ay - Y(k)) - (ax - X(k)) * dy) / len;
      if (d > md) { md = d; mi = k; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[2 * k], pts[2 * k + 1]);
  return out;
}

/* F: stroke alpha (0-255) with the given row stride. The box x0,y0,bw,bh is the strokes' tight box.
   Returns an SVG path in output pixels (the box plus pad on every side), or null. */
function traceOutline(F, stride, x0, y0, bw, bh, pad) {
  const M = 2, gw = bw + 2 * M, gh = bh + 2 * M;
  let G = new Float32Array(gw * gh);
  for (let y = 0; y < bh; y++) {
    const src = (y0 + y) * stride + x0, dst = (y + M) * gw + M;
    for (let x = 0; x < bw; x++) G[dst + x] = F[src + x] / 255;
  }
  // a very light blur so single-pixel steps do not turn into bumps
  const a = 0.25, norm = 1 / (1 + 2 * a);
  const T1 = new Float32Array(G.length);
  for (let y = 0; y < gh; y++) for (let x = 1; x < gw - 1; x++) { const i = y * gw + x; T1[i] = (G[i - 1] * a + G[i] + G[i + 1] * a) * norm; }
  for (let y = 1; y < gh - 1; y++) for (let x = 0; x < gw; x++) { const i = y * gw + x; G[i] = (T1[i - gw] * a + T1[i] + T1[i + gw] * a) * norm; }

  // outline level: the coverage at which the outlines enclose as much area as the strokes
  // had in the photo (blurring spreads thin lines, so a fixed level would make them heavier)
  const hist = new Uint32Array(257);
  let target = 0;
  for (let i = 0; i < G.length; i++) { const v = G[i]; if (v > 0.004) { hist[Math.round(v * 256)]++; target += v; } }
  let ISO = 0.5, cum = 0;
  for (let b = 256; b >= 1; b--) { cum += hist[b]; if (cum >= target) { ISO = (b - 0.5) / 256; break; } }
  ISO = clamp(ISO, 0.28, 0.62);

  const nE = 2 * gw * gh;
  const nxt = new Int32Array(nE).fill(-1);
  const ex = new Float32Array(nE), ey = new Float32Array(nE);
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const v0 = G[j * gw + i], v1 = G[j * gw + i + 1], v2 = G[(j + 1) * gw + i + 1], v3 = G[(j + 1) * gw + i];
      const b0 = v0 >= ISO ? 1 : 0, b1 = v1 >= ISO ? 1 : 0, b2 = v2 >= ISO ? 1 : 0, b3 = v3 >= ISO ? 1 : 0;
      const code = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3);
      if (code === 0 || code === 15) continue;
      const Tp = 2 * (j * gw + i), Bt = 2 * ((j + 1) * gw + i), Lf = 2 * (j * gw + i) + 1, Rt = 2 * (j * gw + i + 1) + 1;
      let t;
      if (b0 !== b1) { t = (ISO - v0) / (v1 - v0); ex[Tp] = i + t; ey[Tp] = j; }
      if (b1 !== b2) { t = (ISO - v1) / (v2 - v1); ex[Rt] = i + 1; ey[Rt] = j + t; }
      if (b3 !== b2) { t = (ISO - v3) / (v2 - v3); ex[Bt] = i + t; ey[Bt] = j + 1; }
      if (b0 !== b3) { t = (ISO - v0) / (v3 - v0); ex[Lf] = i; ey[Lf] = j + t; }
      const mid = (v0 + v1 + v2 + v3) / 4 >= ISO;
      switch (code) {
        case 1: nxt[Lf] = Tp; break;
        case 2: nxt[Tp] = Rt; break;
        case 3: nxt[Lf] = Rt; break;
        case 4: nxt[Rt] = Bt; break;
        case 5: if (mid) { nxt[Rt] = Tp; nxt[Lf] = Bt; } else { nxt[Lf] = Tp; nxt[Rt] = Bt; } break;
        case 6: nxt[Tp] = Bt; break;
        case 7: nxt[Lf] = Bt; break;
        case 8: nxt[Bt] = Lf; break;
        case 9: nxt[Bt] = Tp; break;
        case 10: if (mid) { nxt[Tp] = Lf; nxt[Bt] = Rt; } else { nxt[Tp] = Rt; nxt[Bt] = Lf; } break;
        case 11: nxt[Bt] = Rt; break;
        case 12: nxt[Rt] = Lf; break;
        case 13: nxt[Rt] = Tp; break;
        case 14: nxt[Tp] = Lf; break;
      }
    }
  }

  const seen = new Uint8Array(nE);
  const off = pad - M + 0.5;     // grid point i sits at the centre of source pixel i - M
  const f2 = (v) => (Math.round(v * 100) / 100).toString();
  const parts = [];
  for (let s0 = 0; s0 < nE; s0++) {
    if (nxt[s0] < 0 || seen[s0]) continue;
    let pts = [], e = s0;
    while (e >= 0 && !seen[e]) { seen[e] = 1; pts.push(ex[e] + off, ey[e] + off); e = nxt[e]; }
    if (e !== s0 || pts.length < 6) continue;
    let area = 0;
    for (let k = 0, m = pts.length - 2; k < pts.length; m = k, k += 2) area += pts[m] * pts[k + 1] - pts[k] * pts[m + 1];
    if (Math.abs(area) / 2 < 1.5) continue;              // a speck smaller than a pen dot
    pts = simplifyLoop(pts, 0.16);
    const n = pts.length / 2;
    if (n < 3) continue;
    // smooth curve through the midpoints of the outline, with the outline points as controls
    let d = 'M' + f2((pts[2 * n - 2] + pts[0]) / 2) + ' ' + f2((pts[2 * n - 1] + pts[1]) / 2);
    for (let k = 0; k < n; k++) {
      const nk = (k + 1) % n;
      d += 'Q' + f2(pts[2 * k]) + ' ' + f2(pts[2 * k + 1]) + ' ' + f2((pts[2 * k] + pts[2 * nk]) / 2) + ' ' + f2((pts[2 * k + 1] + pts[2 * nk + 1]) / 2);
    }
    parts.push(d + 'Z');
  }
  return parts.length ? parts.join('') : null;
}

/* ---------- render ---------- */
function schedule() {
  if (S.raf) return;
  S.raf = requestAnimationFrame(() => { S.raf = 0; render(); });
}

function inkRGB(orig) {
  if (S.ink === 'black') return [17, 17, 17];
  if (S.ink === 'blue') return [28, 58, 168];
  if (S.ink === 'custom') {
    const v = parseInt(el.customColor.value.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return orig;
}

function render() {
  if (!S.d) return;
  const c = cropRect();
  const W = S.W, P = S.rgba, D = S.d;

  const wm = detectWatermark(c, S.wmMode);
  const T = clamp(autoThreshold(c, wm) * Math.pow(2, -(+el.sens.value) / 50), 6, 220);
  const wd = (+el.soft.value) / 100;
  const lo = T * (1 - wd), hi = T * (1 + wd), k = 255 / (hi - lo);

  const n = c.w * c.h;
  const A = new Uint8Array(n);
  for (let y = 0; y < c.h; y++) {
    let si = (c.y + y) * W + c.x, di = y * c.w;
    for (let x = 0; x < c.w; x++, si++, di++) {
      const v = D[si];
      A[di] = v <= lo ? 0 : v >= hi ? 255 : ((v - lo) * k + 0.5) | 0;
    }
  }
  if (wm.mask) for (let i = 0; i < n; i++) if (wm.mask[i]) A[i] = 0;
  showWatermarkNote(wm);

  const seedSet = new Set();
  for (const s of S.seeds) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = s.x + dx - c.x, y = s.y + dy - c.y;
      if (x >= 0 && y >= 0 && x < c.w && y < c.h) seedSet.add(y * c.w + x);
    }
  }
  const sc = Math.max(c.w, c.h) / 1000;
  const minArea = Math.round((+el.specks.value / 100) * 120 * sc * sc);
  if (minArea > 0 || seedSet.size) cleanComponents(A, c.w, c.h, minArea, seedSet);

  // bounding box of what is left, and the pen colour from the darkest solid pixels
  let bx0 = c.w, by0 = c.h, bx1 = -1, by1 = -1, tot = 0;
  const bins = new Uint32Array(256), sr = new Float64Array(256), sg = new Float64Array(256), sb = new Float64Array(256);
  for (let y = 0; y < c.h; y++) {
    const row = y * c.w;
    for (let x = 0; x < c.w; x++) {
      const a = A[row + x];
      if (!a) continue;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; by1 = y;
      if (a >= 250) {
        const j = ((c.y + y) * W + c.x + x) * 4;
        const r = P[j], g = P[j + 1], b = P[j + 2];
        const l = (r * 77 + g * 150 + b * 29) >> 8;
        bins[l]++; sr[l] += r; sg[l] += g; sb[l] += b; tot++;
      }
    }
  }

  if (bx1 < 0) { showEmpty('No ink found. Raise the ink sensitivity, or drag a box around the signature on the photo.'); return; }

  let orig = [20, 20, 40];
  if (tot > 0) {
    const target = Math.max(1, Math.round(tot * 0.4));
    let cc = 0, R = 0, G = 0, B = 0;
    for (let l = 0; l < 256 && cc < target; l++) {
      if (!bins[l]) continue;
      cc += bins[l]; R += sr[l]; G += sg[l]; B += sb[l];
    }
    orig = [Math.round(R / cc), Math.round(G / cc), Math.round(B / cc)];
  }
  el.origDot.style.background = 'rgb(' + orig.join(',') + ')';
  const [ir, ig, ib] = inkRGB(orig);

  // line thickness: scaled to the signature's size so it feels the same on any photo
  const th = +el.thick.value;
  const unit = Math.max(bx1 - bx0 + 1, by1 - by0 + 1) / 1000;
  const rpx = th > 0 ? th * 0.4 * unit : th * 0.25 * unit;
  let F = A, stride = c.w, ox = 0, oy = 0, sx0 = bx0, sy0 = by0, sx1 = bx1, sy1 = by1;
  if (Math.abs(rpx) > 0.02) {
    const m = (rpx > 0 ? Math.ceil(rpx) : 0) + 2;
    const rx0 = bx0 - m, ry0 = by0 - m;
    const rw = (bx1 - bx0 + 1) + 2 * m, rh = (by1 - by0 + 1) + 2 * m;
    const reg = new Uint8Array(rw * rh);
    for (let y = by0; y <= by1; y++) {
      const from = y * c.w + bx0;
      reg.set(A.subarray(from, from + (bx1 - bx0 + 1)), (y - ry0) * rw + (bx0 - rx0));
    }
    F = thicken(reg, rw, rh, rpx);
    stride = rw; ox = rx0; oy = ry0; sx0 = 0; sy0 = 0; sx1 = rw - 1; sy1 = rh - 1;
  }

  // tight box around the final strokes
  let tx0 = sx1 + 1, ty0 = sy1 + 1, tx1 = -1, ty1 = -1;
  for (let y = sy0; y <= sy1; y++) {
    const row = y * stride;
    for (let x = sx0; x <= sx1; x++) {
      if (!F[row + x]) continue;
      if (x < tx0) tx0 = x; if (x > tx1) tx1 = x;
      if (y < ty0) ty0 = y; ty1 = y;
    }
  }
  if (tx1 < 0) { showEmpty('Nothing is left at this thickness. Move the Line thickness slider toward Thicker.'); return; }

  el.empty.hidden = true; el.out.hidden = false;
  el.undo.hidden = S.seeds.length === 0;
  const bw = tx1 - tx0 + 1, bh = ty1 - ty0 + 1;
  const pad = Math.round((+el.pad.value / 100) * Math.max(bw, bh));
  const outW = bw + pad * 2, outH = bh + pad * 2;
  const info = { hasInk: true, A, c, bx0: ox + tx0, by0: oy + ty0, pad, outW, outH, grow: Math.max(0, Math.ceil(rpx)), zoom: 1, svg: null };

  if (S.trace) {
    const d = traceOutline(F, stride, tx0, ty0, bw, bh, pad);
    if (d) {
      const z = clamp(Math.round(2400 / Math.max(outW, outH)), 1, 4);
      el.out.width = Math.round(outW * z); el.out.height = Math.round(outH * z);
      const tctx = el.out.getContext('2d');
      tctx.clearRect(0, 0, el.out.width, el.out.height);
      tctx.save();
      tctx.scale(z, z);
      tctx.fillStyle = 'rgb(' + ir + ',' + ig + ',' + ib + ')';
      tctx.fill(new Path2D(d), 'evenodd');
      tctx.restore();
      info.zoom = z;
      applyFx([ir, ig, ib]);
      info.svg = { d, w: outW, h: outH, rgb: [ir, ig, ib] };
      S.last = info;
      el.svg.hidden = false;
      return;
    }
  }
  el.svg.hidden = true;
  el.out.width = outW; el.out.height = outH;
  const ctx = el.out.getContext('2d');
  const img = ctx.createImageData(outW, outH);
  const data = img.data;
  for (let y = 0; y < bh; y++) {
    const srow = (ty0 + y) * stride + tx0;
    let o = ((y + pad) * outW + pad) * 4;
    for (let x = 0; x < bw; x++, o += 4) {
      const a = F[srow + x];
      if (a) { data[o] = ir; data[o + 1] = ig; data[o + 2] = ib; data[o + 3] = a; }
    }
  }
  ctx.putImageData(img, 0, 0);
  applyFx([ir, ig, ib]);
  // A and c stay at the strokes' original thickness so a click can find the mark it points at
  S.last = info;
}

function applyFx(rgb) {
  if (S.fxPen !== 'off' && SX.realInk) SX.realInk(el.out, rgb, S.fxPen, (+el.fx.value) / 100);
}

function showEmpty(msg) {
  el.empty.textContent = msg;
  el.empty.hidden = false;
  el.out.hidden = true;
  el.undo.hidden = S.seeds.length === 0;
  el.out.width = 1; el.out.height = 1;
  el.svg.hidden = true;
  S.last = { hasInk: false };
}

function showWatermarkNote(wm) {
  if (!S.wmMode) { el.wmNote.textContent = ''; return; }
  const n = wm.removed;
  el.wmNote.textContent = n
    ? 'Removed ' + n + (n === 1 ? ' mark' : ' marks') + ' that did not look like pen. Check the edges where a mark crossed the signature.'
    : (S.wmMode === 2 ? 'Nothing found that is lighter or a different colour than the pen.' : 'No watermark found. Try Strong if marks are still there.');
}

/* ---------- selecting the signature on the photo ---------- */
let drag = null;
function pointFrac(e) {
  const r = el.srcImg.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
}
function showSel(s) {
  el.sel.hidden = !s;
  if (!s) return;
  el.sel.style.left = s.x0 * 100 + '%';
  el.sel.style.top = s.y0 * 100 + '%';
  el.sel.style.width = (s.x1 - s.x0) * 100 + '%';
  el.sel.style.height = (s.y1 - s.y0) * 100 + '%';
}
function rectFrom(a, b) {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}
el.srcWrap.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const p = pointFrac(e);
  drag = { start: p, sx: e.clientX, sy: e.clientY, moved: false, rect: null };
  try { el.srcWrap.setPointerCapture(e.pointerId); } catch (_) {}
});
el.srcWrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
  drag.moved = true;
  drag.rect = rectFrom(drag.start, pointFrac(e));
  showSel(drag.rect);
});
function endDrag() {
  if (!drag) return;
  const r = drag.rect;
  drag = null;
  if (r && r.x1 - r.x0 >= 0.02 && r.y1 - r.y0 >= 0.02) {
    S.sel = r;
    el.clearSel.hidden = false;
    schedule();
  }
  showSel(S.sel);
}
el.srcWrap.addEventListener('pointerup', endDrag);
el.srcWrap.addEventListener('pointercancel', endDrag);
el.clearSel.addEventListener('click', () => {
  S.sel = null; showSel(null); el.clearSel.hidden = true; schedule();
});

/* ---------- erase a stray mark ---------- */
el.out.addEventListener('click', (e) => {
  const L = S.last;
  if (!L || !L.hasInk) return;
  const r = el.out.getBoundingClientRect();
  const z = L.zoom || 1;
  const sx = el.out.width / r.width / z, sy = el.out.height / r.height / z;
  const fx = Math.round((e.clientX - r.left) * sx - L.pad + L.bx0);
  const fy = Math.round((e.clientY - r.top) * sy - L.pad + L.by0);
  const rad = Math.ceil(12 * sx) + L.grow;
  let best = -1, bx = 0, by = 0;
  for (let y = Math.max(0, fy - rad); y <= Math.min(L.c.h - 1, fy + rad); y++) {
    for (let x = Math.max(0, fx - rad); x <= Math.min(L.c.w - 1, fx + rad); x++) {
      if (!L.A[y * L.c.w + x]) continue;
      const dd = (x - fx) * (x - fx) + (y - fy) * (y - fy);
      if (best < 0 || dd < best) { best = dd; bx = x; by = y; }
    }
  }
  if (best < 0 || best > rad * rad) { toast('Nothing to erase there.'); return; }
  S.seeds.push({ x: L.c.x + bx, y: L.c.y + by });
  schedule();
  toast('Mark erased.');
});
el.undo.addEventListener('click', () => { S.seeds.pop(); schedule(); });

/* ---------- controls ---------- */
function syncOutputs() {
  const s = +el.sens.value;
  el.sensOut.textContent = s === 0 ? 'Auto' : (s > 0 ? '+' : '') + s;
  el.softOut.textContent = el.soft.value + '%';
  el.specksOut.textContent = el.specks.value;
  el.padOut.textContent = el.pad.value + '%';
  const t = +el.thick.value;
  el.fxOut.textContent = el.fx.value + '%';
  el.thickOut.textContent = t === 0 ? 'Original' : (t > 0 ? '+' : '\u2212') + Math.abs(t);
}
for (const id of ['sens', 'soft', 'specks', 'pad', 'thick', 'fx']) {
  el[id].addEventListener('input', () => { syncOutputs(); schedule(); });
}
function setInk(mode) {
  S.ink = mode;
  document.querySelectorAll('button[data-ink]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ink === mode)));
  el.customChip.classList.toggle('on', mode === 'custom');
  schedule();
}
document.querySelectorAll('button[data-ink]').forEach((b) => b.addEventListener('click', () => setInk(b.dataset.ink)));
el.customColor.addEventListener('input', () => setInk('custom'));
el.customChip.addEventListener('click', (e) => { if (e.target !== el.customColor) { setInk('custom'); } });
const traceSeg = SX.seg($('#trSeg'), (v) => { S.trace = v === '1'; schedule(); });
const wmSeg = SX.seg($('#wmSeg'), (v) => { S.wmMode = +v; schedule(); });
document.querySelectorAll('button[data-fx]').forEach((b) => b.addEventListener('click', () => {
  S.fxPen = b.dataset.fx;
  document.querySelectorAll('button[data-fx]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  el.fxAmt.hidden = S.fxPen === 'off';
  schedule();
}));
const bgSeg = SX.seg($('#bgSeg'), (v) => {
  S.bg = v;
  el.outView.classList.toggle('white', v === 'white');
  el.outView.classList.toggle('checker', v !== 'white');
});

/* ---------- export ---------- */
function exportBlob() {
  return new Promise((resolve, reject) => {
    const cv = document.createElement('canvas');
    cv.width = el.out.width; cv.height = el.out.height;
    const cx = cv.getContext('2d');
    if (S.bg === 'white') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); }
    cx.drawImage(el.out, 0, 0);
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
  });
}

el.download.addEventListener('click', async () => {
  if (!S.last || !S.last.hasInk) { toast('No signature to download yet.', true); return; }
  const filename = S.name + '-signature.png';
  SX.busy(el.download, true, 'Preparing PNG');
  try {
    const blob = await exportBlob();
    SX.busy(el.download, false);
    const ok = await SX.saveBlob(blob, filename);
    if (ok) { SX.flash(el.download, 'Downloaded'); SX.steps(el.steps, 3); }
  } catch (e) {
    SX.busy(el.download, false);
    toast("Couldn't create the PNG. Try again.", true);
  }
});
el.svg.addEventListener('click', async () => {
  const L = S.last;
  if (!L || !L.hasInk || !L.svg) { toast('Turn on Traced output to save an SVG.', true); return; }
  const v = L.svg, z = L.zoom || 1;
  const bg = S.bg === 'white' ? '<rect width="' + v.w + '" height="' + v.h + '" fill="#fff"/>' : '';
  const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + v.w + ' ' + v.h + '" width="' + Math.round(v.w * z) + '" height="' + Math.round(v.h * z) + '">' + bg +
    '<path fill="rgb(' + v.rgb.join(',') + ')" fill-rule="evenodd" d="' + v.d + '"/></svg>';
  const ok = await SX.saveBlob(new Blob([text], { type: 'image/svg+xml' }), S.name + '-signature.svg');
  if (ok) SX.flash(el.svg, 'Downloaded');
});
if (!(navigator.clipboard && window.ClipboardItem)) el.copy.hidden = true;
el.copy.addEventListener('click', async () => {
  if (!S.last || !S.last.hasInk) { toast('No signature to copy yet.', true); return; }
  try {
    const blob = await exportBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    SX.flash(el.copy, 'Copied');
  } catch (e) {
    toast("Copy isn't available here. Use Download PNG instead.", true);
  }
});

/* ---------- getting a file in ---------- */
el.file.addEventListener('change', () => { const f = el.file.files && el.file.files[0]; el.file.value = ''; if (f) loadFile(f); });
el.sample.addEventListener('click', async () => {
  try { loadFile(await SX.fetchFile('assets/sample-signature-photo.jpg', 'sample-photo.jpg', 'image/jpeg')); }
  catch (e) { toast("The sample isn't available when this page is opened from a file. Choose your own photo.", true); }
});
SX.tools.signature = { load: loadFile, over: (v) => el.drop.classList.toggle('over', v) };

el.again.addEventListener('click', async () => {
  SX.steps(el.steps, 1);
  await SX.swap(el.work, el.intro);
  S.d = null; S.rgba = null; S.last = null; S.sel = null; S.seeds = [];
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  el.srcImg.removeAttribute('src');
});

syncOutputs();
})();
