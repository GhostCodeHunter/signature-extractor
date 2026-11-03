
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
};

const S = {
  W: 0, H: 0, rgba: null, d: null,
  sel: null, seeds: [], ink: 'original', bg: 'transparent',
  tKey: '', tVal: 60, last: null, url: null, name: 'signature', raf: 0,
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
  S.sel = null; S.seeds = []; S.tKey = '';
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

/* Otsu split between faint and solid ink, ignoring paper texture. */
function autoThreshold(c) {
  const key = c.x + ',' + c.y + ',' + c.w + ',' + c.h;
  if (S.tKey === key) return S.tVal;
  const hist = new Uint32Array(256);
  const D = S.d, W = S.W;
  for (let y = 0; y < c.h; y++) {
    let i = (c.y + y) * W + c.x;
    for (let x = 0; x < c.w; x++) hist[D[i++]]++;
  }
  let total = 0, sum = 0;
  for (let t = NOISE_FLOOR; t < 256; t++) { total += hist[t]; sum += t * hist[t]; }
  let T = 60;
  if (total >= 40) {
    let wB = 0, sumB = 0, best = -1;
    for (let t = NOISE_FLOOR; t < 256; t++) {
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
  S.tKey = key; S.tVal = clamp(T, 20, 170);
  return S.tVal;
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

  const T = clamp(autoThreshold(c) * Math.pow(2, -(+el.sens.value) / 50), 6, 220);
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
  // A and c stay at the strokes' original thickness so a click can find the mark it points at
  S.last = { hasInk: true, A, c, bx0: ox + tx0, by0: oy + ty0, pad, outW, outH, grow: Math.max(0, Math.ceil(rpx)) };
}

function showEmpty(msg) {
  el.empty.textContent = msg;
  el.empty.hidden = false;
  el.out.hidden = true;
  el.undo.hidden = S.seeds.length === 0;
  el.out.width = 1; el.out.height = 1;
  S.last = { hasInk: false };
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
  const sx = el.out.width / r.width, sy = el.out.height / r.height;
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
  el.thickOut.textContent = t === 0 ? 'Original' : (t > 0 ? '+' : '\u2212') + Math.abs(t);
}
for (const id of ['sens', 'soft', 'specks', 'pad', 'thick']) {
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
