/* Photo restore engine. It is written as one function so the page can run it in a
   Web Worker without fetching another file (the same source also runs in Node for tests).
   Everything is classic image processing: no model, no learned detail. */
function restoreEngineWorker() {
  'use strict';

  var base = null; // preview source kept inside the worker: { w, h, data }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function lumaPlane(d, n) {
    var y = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) y[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29 + 128) >> 8;
    return y;
  }

  /* 1. Fading and colour: per-channel levels from the 0.5% / 99.5% percentiles, then a gentle
        lift of dark photos. `s` (0..1) blends between the original and the corrected tones. */
  function autoLevels(d, n, s) {
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (var i = 0, j = 0; i < n; i++, j += 4) { hist[0][d[j]]++; hist[1][d[j + 1]]++; hist[2][d[j + 2]]++; }
    var lut = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    var info = { lo: [], hi: [], exp: 1 };
    var c, v, cum, lo, hi, mid, st;
    for (c = 0; c < 3; c++) {
      cum = 0; lo = 0; hi = 255;
      var a = 0.005 * n, b = 0.995 * n, gotLo = false;
      for (v = 0; v < 256; v++) {
        cum += hist[c][v];
        if (!gotLo && cum >= a) { lo = v; gotLo = true; }
        if (cum >= b) { hi = v; break; }
      }
      if (hi - lo < 48) { mid = (hi + lo) / 2; lo = Math.max(0, mid - 24); hi = Math.min(255, mid + 24); if (hi - lo < 48) { if (lo === 0) hi = 48; else lo = 207; } }
      info.lo.push(lo); info.hi.push(hi);
      for (v = 0; v < 256; v++) {
        st = clamp((v - lo) / (hi - lo), 0, 1) * 255;
        lut[c][v] = v + (st - v) * s;
      }
    }
    // brighten only: aim the mean tone near 44% grey
    var mean = 0;
    for (c = 0; c < 3; c++) {
      var m = 0;
      for (v = 0; v < 256; v++) m += hist[c][v] * lut[c][v];
      mean += (c === 0 ? 77 : c === 1 ? 150 : 29) * (m / n);
    }
    mean = mean / 256 / 255;
    if (mean > 0.01 && mean < 0.44) {
      var e = clamp(Math.log(0.44) / Math.log(mean), 0.55, 1);
      e = 1 + (e - 1) * s;
      info.exp = e;
      for (c = 0; c < 3; c++) for (v = 0; v < 256; v++) lut[c][v] = 255 * Math.pow(lut[c][v] / 255, e);
    }
    var L0 = new Uint8Array(256), L1 = new Uint8Array(256), L2 = new Uint8Array(256);
    for (v = 0; v < 256; v++) { L0[v] = Math.round(lut[0][v]); L1[v] = Math.round(lut[1][v]); L2[v] = Math.round(lut[2][v]); }
    for (i = 0, j = 0; i < n; i++, j += 4) { d[j] = L0[d[j]]; d[j + 1] = L1[d[j + 1]]; d[j + 2] = L2[d[j + 2]]; }
    return info;
  }

  /* 2. Dust and scratches: a pixel that stands out from three or more of its eight neighbours
        on a ring around it (a speck or a thin line, not an edge) is repaired from nearby clean pixels. */
  function removeDust(d, w, h, s, rW) {
    var n = w * h, Y = lumaPlane(d, n);
    var dd = rW + 1;
    var mask = new Uint8Array(n);
    var ring = new Int32Array(8);
    var T = 70 - 35 * s, count = 0, tries = 0;
    for (;;) {
      mask.fill(0); count = 0;
      for (var y = 0; y < h; y++) {
        var yu = y - dd < 0 ? 0 : y - dd, yd = y + dd >= h ? h - 1 : y + dd;
        var ru = yu * w, rm = y * w, rd = yd * w;
        for (var x = 0; x < w; x++) {
          var xl = x - dd < 0 ? 0 : x - dd, xr = x + dd >= w ? w - 1 : x + dd;
          var v = Y[rm + x];
          ring[0] = Y[ru + xl]; ring[1] = Y[ru + x]; ring[2] = Y[ru + xr];
          ring[3] = Y[rm + xl]; ring[4] = Y[rm + xr];
          ring[5] = Y[rd + xl]; ring[6] = Y[rd + x]; ring[7] = Y[rd + xr];
          var mn = 255, mx = 0, k;
          for (k = 0; k < 8; k++) { var r = ring[k]; if (r < mn) mn = r; if (r > mx) mx = r; }
          var bright = v - T > mn, dark = v + T < mx;
          if (!bright && !dark) continue;
          // third largest and third smallest of the ring
          var a1 = -1, a2 = -1, a3 = -1, b1 = 256, b2 = 256, b3 = 256;
          for (k = 0; k < 8; k++) {
            var q = ring[k];
            if (q > a1) { a3 = a2; a2 = a1; a1 = q; } else if (q > a2) { a3 = a2; a2 = q; } else if (q > a3) a3 = q;
            if (q < b1) { b3 = b2; b2 = b1; b1 = q; } else if (q < b2) { b3 = b2; b2 = q; } else if (q < b3) b3 = q;
          }
          if ((bright && v - T > a3) || (dark && v + T < b3)) { mask[rm + x] = 1; count++; }
        }
      }
      if (count / n > 0.05 && tries < 3) { T *= 1.35; tries++; continue; }
      break;
    }
    if (count === 0) return { repaired: 0 };
    // grow the mask a little: the soft rim of a speck is never as strong as its core
    var grow = rW >= 4 ? 2 : 1;
    var m2 = new Uint8Array(n), total = 0;
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
      if (mask[yy * w + xx] !== 1) continue;
      var y0 = Math.max(0, yy - grow), y1 = Math.min(h - 1, yy + grow), x0 = Math.max(0, xx - grow), x1 = Math.min(w - 1, xx + grow);
      for (var py = y0; py <= y1; py++) for (var px = x0; px <= x1; px++) m2[py * w + px] = 1;
    }
    for (var i = 0; i < n; i++) total += m2[i];
    var R = rW + grow + 2, side = 2 * R + 1;
    var wt = new Float32Array(side * side);
    for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) wt[(dy + R) * side + dx + R] = 1 / (1 + dx * dx + dy * dy);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var idx = y * w + x;
      if (!m2[idx]) continue;
      var sr = 0, sg = 0, sb = 0, sw = 0;
      var ya = Math.max(0, y - R), yb = Math.min(h - 1, y + R), xa = Math.max(0, x - R), xb = Math.min(w - 1, x + R);
      for (var cy = ya; cy <= yb; cy++) {
        var rowi = cy * w, wr = (cy - y + R) * side - x + R;
        for (var cx = xa; cx <= xb; cx++) {
          var jj = rowi + cx;
          if (m2[jj]) continue;
          var ww = wt[wr + cx];
          sw += ww; sr += ww * d[jj * 4]; sg += ww * d[jj * 4 + 1]; sb += ww * d[jj * 4 + 2];
        }
      }
      if (sw > 0) { var p = idx * 4; d[p] = sr / sw + 0.5; d[p + 1] = sg / sw + 0.5; d[p + 2] = sb / sw + 0.5; }
    }
    return { repaired: total, found: count };
  }

  /* 3. Noise: bilateral filter. Weights come from brightness, so edges stay where they are
        and colour noise in flat areas is averaged away. Returns a new buffer. */
  function denoise(d, w, h, n01, longSide, progress) {
    var n = w * h, Y = lumaPlane(d, n);
    var r = 1 + (n01 > 0.33 ? 1 : 0) + (n01 > 0.66 ? 1 : 0);
    if (longSide > 2400) r++;
    r = Math.min(r, n > 8e6 ? 2 : 4);
    var sS = r * 0.6 + 0.4, sR = 4 + 30 * n01;
    var rl = new Float32Array(256);
    for (var k = 0; k < 256; k++) rl[k] = Math.exp(-(k * k) / (2 * sR * sR));
    var side = 2 * r + 1, sw = new Float32Array(side * side);
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) sw[(dy + r) * side + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * sS * sS));
    var mix = 0.5 + 0.5 * n01;
    var out = new Uint8ClampedArray(d.length);
    var step = Math.max(1, (h / 20) | 0);
    for (var y = 0; y < h; y++) {
      if (progress && y % step === 0) progress(y / h);
      for (var x = 0; x < w; x++) {
        var i = y * w + x, yc = Y[i];
        var sr = 0, sg = 0, sb = 0, ws = 0;
        for (var oy = -r; oy <= r; oy++) {
          var yy = y + oy; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          var rowBase = yy * w, wb = (oy + r) * side + r;
          for (var ox = -r; ox <= r; ox++) {
            var xx = x + ox; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
            var j = rowBase + xx, df = Y[j] - yc;
            var wgt = sw[wb + ox] * rl[df < 0 ? -df : df];
            ws += wgt; sr += wgt * d[j * 4]; sg += wgt * d[j * 4 + 1]; sb += wgt * d[j * 4 + 2];
          }
        }
        var p = i * 4;
        out[p] = d[p] + (sr / ws - d[p]) * mix;
        out[p + 1] = d[p + 1] + (sg / ws - d[p + 1]) * mix;
        out[p + 2] = d[p + 2] + (sb / ws - d[p + 2]) * mix;
        out[p + 3] = 255;
      }
    }
    return out;
  }

  /* 4. Colour boost: raises muted colours more than strong ones. */
  function vibrance(d, n, amount) {
    var k = amount * 0.7;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var r = d[j], g = d[j + 1], b = d[j + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx === 0) continue;
      var sat = (mx - mn) / mx;
      var f = 1 + k * (1 - sat);
      var gray = (r * 77 + g * 150 + b * 29) / 256;
      d[j] = gray + (r - gray) * f; d[j + 1] = gray + (g - gray) * f; d[j + 2] = gray + (b - gray) * f;
    }
  }

  /* 5. Upscale: Lanczos-3, one channel at a time to keep memory small. */
  function lanczos(x) {
    if (x === 0) return 1;
    if (x <= -3 || x >= 3) return 0;
    var px = Math.PI * x;
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
  }
  function taps(srcN, dstN) {
    var sc = dstN / srcN, starts = new Int32Array(dstN), w = new Float32Array(dstN * 6);
    for (var o = 0; o < dstN; o++) {
      var cs = (o + 0.5) / sc - 0.5, i0 = Math.floor(cs) - 2, sum = 0;
      starts[o] = i0;
      for (var k = 0; k < 6; k++) { var v = lanczos(cs - (i0 + k)); w[o * 6 + k] = v; sum += v; }
      for (k = 0; k < 6; k++) w[o * 6 + k] /= sum;
    }
    return { starts: starts, w: w };
  }
  function upscale(d, w, h, dw, dh, progress) {
    var tx = taps(w, dw), ty = taps(h, dh);
    var out = new Uint8ClampedArray(dw * dh * 4);
    var tmp = new Float32Array(dw * h), row = new Float32Array(dw);
    for (var c = 0; c < 3; c++) {
      var y, x, k;
      for (y = 0; y < h; y++) {
        var sb = y * w;
        for (x = 0; x < dw; x++) {
          var i0 = tx.starts[x], acc = 0;
          for (k = 0; k < 6; k++) {
            var xi = i0 + k; xi = xi < 0 ? 0 : xi >= w ? w - 1 : xi;
            acc += tx.w[x * 6 + k] * d[(sb + xi) * 4 + c];
          }
          tmp[y * dw + x] = acc;
        }
      }
      for (y = 0; y < dh; y++) {
        row.fill(0);
        var j0 = ty.starts[y];
        for (k = 0; k < 6; k++) {
          var yi = j0 + k; yi = yi < 0 ? 0 : yi >= h ? h - 1 : yi;
          var wk = ty.w[y * 6 + k], tb = yi * dw;
          for (x = 0; x < dw; x++) row[x] += wk * tmp[tb + x];
        }
        var ob = y * dw * 4 + c;
        for (x = 0; x < dw; x++) out[ob + x * 4] = row[x];
      }
      if (progress) progress((c + 1) / 3);
    }
    for (var a = 3; a < out.length; a += 4) out[a] = 255;
    return out;
  }

  /* 6. Sharpen: unsharp mask on brightness only, with a small dead zone so noise is not boosted. */
  function boxBlur(src, w, h, r) {
    var tmp = new Uint8Array(w * h), dst = new Uint8Array(w * h);
    var div = 2 * r + 1, inv = 1 / div, x, y, sum, k;
    for (y = 0; y < h; y++) {
      var rb = y * w; sum = 0;
      for (k = -r; k <= r; k++) sum += src[rb + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (x = 0; x < w; x++) {
        tmp[rb + x] = sum * inv + 0.5;
        var add = x + r + 1; add = add >= w ? w - 1 : add;
        var sub = x - r; sub = sub < 0 ? 0 : sub;
        sum += src[rb + add] - src[rb + sub];
      }
    }
    var col = new Int32Array(w);
    for (y = -r; y <= r; y++) { var yy = y < 0 ? 0 : y >= h ? h - 1 : y; for (x = 0; x < w; x++) col[x] += tmp[yy * w + x]; }
    for (y = 0; y < h; y++) {
      var ob = y * w;
      for (x = 0; x < w; x++) dst[ob + x] = col[x] * inv + 0.5;
      var ya = y + r + 1; ya = ya >= h ? h - 1 : ya;
      var ys = y - r; ys = ys < 0 ? 0 : ys;
      for (x = 0; x < w; x++) col[x] += tmp[ya * w + x] - tmp[ys * w + x];
    }
    return dst;
  }
  function sharpen(d, w, h, amount, longSide) {
    var n = w * h, Y = lumaPlane(d, n);
    var rb = clamp(Math.round(longSide / 2200), 1, 4);
    var B = boxBlur(boxBlur(Y, w, h, rb), w, h, rb);
    var thr = 2;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var df = Y[i] - B[i];
      var ad = df < 0 ? -df : df;
      if (ad <= thr) continue;
      var dl = amount * (df > 0 ? df - thr : df + thr);
      dl = dl > 60 ? 60 : dl < -60 ? -60 : dl;
      d[j] += dl; d[j + 1] += dl; d[j + 2] += dl;
    }
  }

  /* the whole pipeline, in the order that gives the cleanest result */
  function run(src, w, h, p, progress, own) {
    var d = own ? src : new Uint8ClampedArray(src);
    var n = w * h, ls = Math.max(w, h), info = {};
    var tot = 0, done = 0, report = function (f) { if (progress) progress(Math.min(1, (done + f) / tot)); };
    var steps = [];
    if (p.fade > 0) steps.push(['levels', 1]);
    if (p.dust > 0) steps.push(['dust', 3]);
    if (p.noise > 0) steps.push(['noise', 8]);
    if (p.color > 0) steps.push(['color', 1]);
    var scale = p.scale > 1 ? p.scale : 1;
    if (scale > 1) steps.push(['upscale', 4 * scale]);
    if (p.sharp > 0) steps.push(['sharp', 2 * scale * scale]);
    steps.forEach(function (s) { tot += s[1]; });
    function end(wt) { done += wt; report(0); }
    for (var si = 0; si < steps.length; si++) {
      var nm = steps[si][0], wt = steps[si][1];
      if (nm === 'levels') { info.levels = autoLevels(d, n, p.fade / 100); }
      else if (nm === 'dust') { info.dust = removeDust(d, w, h, p.dust / 100, clamp(Math.round(ls / 800), 2, 6)); }
      else if (nm === 'noise') { d = denoise(d, w, h, p.noise / 100, ls, function (f) { report(f * wt); }); }
      else if (nm === 'color') { vibrance(d, n, p.color / 100); }
      else if (nm === 'upscale') {
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        d = upscale(d, w, h, nw, nh, function (f) { report(f * wt); });
        w = nw; h = nh; n = w * h; ls = Math.max(w, h);
      }
      else if (nm === 'sharp') { sharpen(d, w, h, (p.sharp / 100) * 2.2 * (1 + 0.2 * Math.log(scale) / Math.LN2), ls); }
      end(wt);
    }
    return { data: d, w: w, h: h, info: info };
  }

  self.__engine = { run: run, autoLevels: autoLevels, removeDust: removeDust, denoise: denoise, upscale: upscale, sharpen: sharpen, vibrance: vibrance };

  self.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.type === 'init') {
        base = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.data) };
        self.postMessage({ type: 'ready' });
      } else if (m.type === 'run') {
        var last = -1, post = function (f) {
          var q = Math.round(f * 100);
          if (q !== last && m.full) { last = q; self.postMessage({ type: 'progress', id: m.id, p: f }); }
        };
        var res;
        if (m.full) res = run(new Uint8ClampedArray(m.full.data), m.full.w, m.full.h, m.params, post, true);
        else res = run(base.data, base.w, base.h, m.params, null, false);
        self.postMessage({ type: 'done', id: m.id, w: res.w, h: res.h, data: res.data.buffer, info: res.info }, [res.data.buffer]);
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: m && m.id, message: String(err && err.message || err) });
    }
  };
}
