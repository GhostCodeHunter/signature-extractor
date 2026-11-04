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
  function removeDust(d, w, h, s, rW, skip) {
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
          if (skip && x >= skip[0] && x <= skip[2] && y >= skip[1] && y <= skip[3]) continue;
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

  /* 7. Edge steepening after each 2x step: a gentle shock filter. Edges that interpolation
        spread out are pulled back toward the darker or lighter side, so they look crisp
        without the halos an unsharp mask adds. Flat areas and noise are left alone. */
  function shock(d, w, h, strength, r) {
    var n = w * h, Y = lumaPlane(d, n);
    var B = boxBlur(boxBlur(Y, w, h, r), w, h, r);
    var k = 0.6 * strength, rr = r * r, w2 = w * r;
    for (var y = r; y < h - r; y++) {
      for (var x = r; x < w - r; x++) {
        var i = y * w + x;
        var gx = (B[i + r] - B[i - r]) / (2 * r), gy = (B[i + w2] - B[i - w2]) / (2 * r);
        var mag = Math.sqrt(gx * gx + gy * gy);
        if (mag < 2) continue;
        var lap = (B[i + r] + B[i - r] + B[i + w2] + B[i - w2] - 4 * B[i]) / rr;
        var t = lap / 2; t = t / (1 + (t < 0 ? -t : t));       // soft sign: no hard flips on flat ramps
        var ramp = (mag - 2) / 6; if (ramp > 1) ramp = 1;
        if (mag > 28) mag = 28;
        var dl = -k * mag * t * ramp;
        var j = i * 4;
        d[j] += dl; d[j + 1] += dl; d[j + 2] += dl;
      }
    }
  }

  /* All the detail stages for one block of pixels. Used for the whole photo, and again
     with gentler settings for each protected face. */
  function enhance(d, w, h, p, progress) {
    var st = { d: d, w: w, h: h }, info = {};
    var scale = p.scale > 1 ? p.scale : 1;
    var ups = scale > 1 ? Math.round(Math.log(scale) / Math.LN2) : 0;
    var noise = Math.min(100, p.noise + (ups && p.bump !== false ? 8 * ups : 0));
    var ls0 = p.refLong || Math.max(w, h);
    var plan = [];
    if (p.dust > 0) plan.push(['dust', 3]);
    if (noise > 0) plan.push(['noise', 8]);
    if (p.color > 0) plan.push(['color', 1]);
    for (var k = 1; k <= ups; k++) plan.push(['up', Math.pow(4, k) * 1.5, k]);
    if (p.sharp > 0) plan.push(['sharp', 1.5 * scale * scale]);
    var tot = 0, done = 0;
    plan.forEach(function (x) { tot += x[1]; });
    var report = function (f) { if (progress) progress(Math.min(1, (done + f) / tot)); };
    for (var si = 0; si < plan.length; si++) {
      var nm = plan[si][0], wt = plan[si][1];
      var lsNow = ls0 * (st.w / w);
      if (nm === 'dust') {
        info.dust = removeDust(st.d, st.w, st.h, p.dust / 100, clamp(Math.round(lsNow / 800), 2, 6), p.dustSkip);
      } else if (nm === 'noise') {
        st.d = denoise(st.d, st.w, st.h, noise / 100, lsNow, function (f) { report(f * wt); });
      } else if (nm === 'color') {
        vibrance(st.d, st.w * st.h, p.color / 100);
      } else if (nm === 'up') {
        var nw = st.w * 2, nh = st.h * 2;
        st.d = upscale(st.d, st.w, st.h, nw, nh, function (f) { report(f * wt); });
        st.w = nw; st.h = nh;
        if (p.sharp > 0 && p.shock !== false) shock(st.d, st.w, st.h, (p.sharp / 100) * 0.9, Math.pow(2, plan[si][2] - 1));
      } else if (nm === 'sharp') {
        sharpen(st.d, st.w, st.h, (p.sharp / 100) * 2.2 * (1 + 0.2 * ups), ls0 * (st.w / w));
      }
      done += wt; report(0);
    }
    st.info = info;
    return st;
  }

  /* Face protection. A face is an ellipse { cx, cy, rx, ry } in pixels of the image being
     processed. Inside it the result of a gentler pass is blended over the normal one. */
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  function faceCrop(d, w, h, f) {
    var pad = Math.max(6, Math.round(0.08 * Math.max(f.rx, f.ry)));
    var x0 = Math.max(0, Math.floor(f.cx - 1.25 * f.rx) - pad), x1 = Math.min(w, Math.ceil(f.cx + 1.25 * f.rx) + pad);
    var y0 = Math.max(0, Math.floor(f.cy - 1.25 * f.ry) - pad), y1 = Math.min(h, Math.ceil(f.cy + 1.25 * f.ry) + pad);
    var cw = x1 - x0, ch = y1 - y0;
    if (cw < 8 || ch < 8) return null;
    var data = new Uint8ClampedArray(cw * ch * 4);
    for (var y = 0; y < ch; y++) data.set(d.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * cw * 4);
    // specks are not repaired around the eyes, where bright catchlights are part of the face
    var bw = f.rx / 0.62, bh = f.ry / 0.72, top = f.cy - bh / 2;
    var skip = [f.cx - bw * 0.55 - x0, top + 0.18 * bh - y0, f.cx + bw * 0.55 - x0, top + 0.55 * bh - y0];
    return { x0: x0, y0: y0, cw: cw, ch: ch, data: data, skip: skip };
  }

  function blendFace(out, ow, oh, B, bw, bh, crop, s, f) {
    var ox = crop.x0 * s, oy = crop.y0 * s;
    var ccx = f.cx * s, ccy = f.cy * s, rx = f.rx * s, ry = f.ry * s;
    for (var y = 0; y < bh; y++) {
      var gy = oy + y; if (gy >= oh) break;
      var ny = (gy + 0.5 - ccy) / ry, ny2 = ny * ny;
      if (ny2 > 1.6) continue;
      for (var x = 0; x < bw; x++) {
        var gx = ox + x; if (gx >= ow) break;
        var nx = (gx + 0.5 - ccx) / rx;
        var dd = Math.sqrt(nx * nx + ny2);
        if (dd >= 1.25) continue;
        var wgt = 1 - smooth(0.9, 1.25, dd);
        if (wgt <= 0) continue;
        var a = (gy * ow + gx) * 4, b = (y * bw + x) * 4;
        out[a] += (B[b] - out[a]) * wgt;
        out[a + 1] += (B[b + 1] - out[a + 1]) * wgt;
        out[a + 2] += (B[b + 2] - out[a + 2]) * wgt;
      }
    }
  }

  /* 8. Background: ID and passport photos need one even colour behind the person. The backdrop is found from the
        photo's own edges (the colour must reach the border and stay close to a smoothly varying estimate of itself),
        and only those pixels are made even. Where hair or a shoulder blends into the backdrop, the blend is
        kept: just the backdrop's share of each pixel is swapped for the new colour. The person is not touched. */
  var BG_TARGET = [null, [168, 212, 252], [0, 130, 255], [255, 255, 255], [232, 232, 232]];   // keep, sky blue, blue, white, grey
  var BG_CUSTOM = 5;                   // a picked colour is passed in with it
  function median(a) { a.sort(function (x, y) { return x - y; }); return a[a.length >> 1]; }
  function cleanBackground(d, w, h, mode, custom) {
    var sc = Math.max(1, Math.ceil(Math.max(w, h) / 360)), sw = Math.max(8, Math.floor(w / sc)), sh = Math.max(8, Math.floor(h / sc));
    var N = sw * sh, S = new Float32Array(N * 3), x, y, i, c, a, b;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      var r0 = 0, g0 = 0, b0 = 0, cnt = 0;
      for (b = 0; b < sc; b++) { var yy = y * sc + b; if (yy >= h) break; for (a = 0; a < sc; a++) { var xx = x * sc + a; if (xx >= w) break; var j = (yy * w + xx) * 4; r0 += d[j]; g0 += d[j + 1]; b0 += d[j + 2]; cnt++; } }
      i = (y * sw + x) * 3; S[i] = r0 / cnt; S[i + 1] = g0 / cnt; S[i + 2] = b0 / cnt;
    }
    // seeds: the top rows, and the sides of the upper part of the photo
    var seeds = [], bt = Math.max(1, Math.round(sh * 0.04)), bs = Math.max(1, Math.round(sw * 0.04));
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      if (y < bt || (y < sh * 0.55 && (x < bs || x >= sw - bs))) seeds.push(y * sw + x);
    }
    var cr = [], cg = [], cb = [];
    seeds.forEach(function (q) { cr.push(S[q * 3]); cg.push(S[q * 3 + 1]); cb.push(S[q * 3 + 2]); });
    var bc = [median(cr), median(cg), median(cb)];
    var tg = mode === BG_CUSTOM && custom && custom.length === 3 ? custom : BG_TARGET[mode];
    if (!tg) return { found: false, share: 0 };
    function dist(q, c0, c1, c2) { var dr = S[q * 3] - c0, dg = S[q * 3 + 1] - c1, db = S[q * 3 + 2] - c2; return Math.sqrt(dr * dr + dg * dg + db * db); }
    var sd = seeds.map(function (q) { return dist(q, bc[0], bc[1], bc[2]); });
    var mad = median(sd.slice());
    var T1 = Math.max(42, 3 * mad);
    var TS = 11;       // the backdrop changes slowly: a jump this big between neighbouring cells is the edge of the person
    function step(p, q) { var dr = S[p * 3] - S[q * 3], dg = S[p * 3 + 1] - S[q * 3 + 1], db = S[p * 3 + 2] - S[q * 3 + 2]; return dr * dr + dg * dg + db * db < TS * TS; }
    function flood(map, thr) {      // pixels close to the estimate, connected to the photo's edge without crossing an edge
      var M = new Uint8Array(N), stack = [], q;
      for (var k = 0; k < seeds.length; k++) { q = seeds[k]; if (!M[q] && thr(q)) { M[q] = 1; stack.push(q); } }
      while (stack.length) {
        q = stack.pop(); var qx = q % sw, qy = (q / sw) | 0;
        if (qx > 0 && !M[q - 1] && thr(q - 1) && step(q, q - 1)) { M[q - 1] = 1; stack.push(q - 1); }
        if (qx < sw - 1 && !M[q + 1] && thr(q + 1) && step(q, q + 1)) { M[q + 1] = 1; stack.push(q + 1); }
        if (qy > 0 && !M[q - sw] && thr(q - sw) && step(q, q - sw)) { M[q - sw] = 1; stack.push(q - sw); }
        if (qy < sh - 1 && !M[q + sw] && thr(q + sw) && step(q, q + sw)) { M[q + sw] = 1; stack.push(q + sw); }
      }
      return M;
    }
    var M1 = flood(null, function (q) { return dist(q, bc[0], bc[1], bc[2]) < T1; });
    // a smooth estimate of the backdrop colour (it may be lighter on one side): blur the found pixels, normalised
    function blurF(src, r) {
      var tmp = new Float32Array(N), out = new Float32Array(N), t, k, sum;
      var cur = src, nxt = tmp;
      for (var pass = 0; pass < 2; pass++) {
        for (y = 0; y < sh; y++) { sum = 0; for (k = -r; k <= r; k++) sum += cur[y * sw + clamp(k, 0, sw - 1)]; for (x = 0; x < sw; x++) { nxt[y * sw + x] = sum; sum += cur[y * sw + clamp(x + r + 1, 0, sw - 1)] - cur[y * sw + clamp(x - r, 0, sw - 1)]; } }
        for (x = 0; x < sw; x++) { sum = 0; for (k = -r; k <= r; k++) sum += nxt[clamp(k, 0, sh - 1) * sw + x]; for (y = 0; y < sh; y++) { out[y * sw + x] = sum; sum += nxt[clamp(y + r + 1, 0, sh - 1) * sw + x] - nxt[clamp(y - r, 0, sh - 1) * sw + x]; } }
        cur = out; nxt = pass === 0 ? new Float32Array(N) : tmp;
      }
      return out;
    }
    function bgMap(M) {
      var rad = Math.max(2, Math.round(Math.max(sw, sh) * 0.1)), res = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], wt = new Float32Array(N), ch = new Float32Array(N);
      for (i = 0; i < N; i++) wt[i] = M[i];
      var den = blurF(wt, rad);
      for (c = 0; c < 3; c++) {
        for (i = 0; i < N; i++) ch[i] = M[i] ? S[i * 3 + c] : 0;
        var num = blurF(ch, rad);
        for (i = 0; i < N; i++) res[c][i] = den[i] > 1e-3 ? num[i] / den[i] : bc[c];
      }
      return res;
    }
    var B1 = bgMap(M1);
    // lower down the photo the person's clothes are what is being told apart from the wall, so the tolerance narrows
    var M2 = flood(null, function (q) {
      var dr = S[q * 3] - B1[0][q], dg = S[q * 3 + 1] - B1[1][q], db = S[q * 3 + 2] - B1[2][q], t = ((q / sw) | 0) / sh;
      return Math.sqrt(dr * dr + dg * dg + db * db) < 40 - 20 * smooth(0.5, 0.7, t);
    });
    // smudges and stains: any lump that is not the person (it does not reach the bottom or the lower sides, and it is small) is backdrop too
    var lab = new Int32Array(N), stk = [], comps = [];
    for (var s0 = 0; s0 < N; s0++) {
      if (M2[s0] || lab[s0]) continue;
      var id = comps.length + 1, size = 0, keep = false;
      lab[s0] = id; stk.push(s0);
      while (stk.length) {
        var q = stk.pop(); size++;
        var qx = q % sw, qy = (q / sw) | 0;
        if (qy >= sh - 1 || ((qx === 0 || qx === sw - 1) && qy > sh * 0.45)) keep = true;
        for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
          var nx = qx + ox, ny = qy + oy;
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          var nq = ny * sw + nx;
          if (!M2[nq] && !lab[nq]) { lab[nq] = id; stk.push(nq); }
        }
      }
      comps.push({ id: id, size: size, keep: keep || size >= N * 0.06 });
    }
    var drop = new Uint8Array(comps.length + 1);
    comps.forEach(function (cm) { if (!cm.keep) drop[cm.id] = 1; });
    for (i = 0; i < N; i++) if (lab[i] && drop[lab[i]]) M2[i] = 1;
    // thin spikes of "backdrop" that poke into the person (where clothing nearly matches the wall) are not backdrop
    function morph(M, r, grow) {
      var T = new Uint8Array(N), O = new Uint8Array(N), k, v;
      for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
        v = grow ? 0 : 1;
        for (k = -r; k <= r; k++) { var xx = x + k; if (xx < 0 || xx >= sw) continue; if (grow ? M[y * sw + xx] : !M[y * sw + xx]) { v = grow ? 1 : 0; break; } }
        T[y * sw + x] = v;
      }
      for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
        v = grow ? 0 : 1;
        for (k = -r; k <= r; k++) { var yy = y + k; if (yy < 0 || yy >= sh) continue; if (grow ? T[yy * sw + x] : !T[yy * sw + x]) { v = grow ? 1 : 0; break; } }
        O[y * sw + x] = v;
      }
      return O;
    }
    var opened = morph(morph(M2, 2, false), 2, true);
    for (i = 0; i < N; i++) M2[i] = opened[i] & M2[i];
    var share = 0; for (i = 0; i < N; i++) share += M2[i];
    share /= N;
    var okSeeds = 0; seeds.forEach(function (q) { okSeeds += M2[q]; });
    if (share < 0.06 || okSeeds < seeds.length * 0.5) return { found: false, share: share };
    var B2 = bgMap(M2);
    // the gate: backdrop pixels grown a little, so blended hair and shoulder edges are included
    var G = new Float32Array(N), gr = Math.max(1, Math.round(Math.max(sw, sh) * 0.012));
    for (i = 0; i < N; i++) G[i] = M2[i];
    var Gb = blurF(G, gr);
    var norm = Math.pow(2 * gr + 1, 4);
    var GD = new Float32Array(N);       // deep inside the backdrop: specks and dust there are backdrop too
    for (i = 0; i < N; i++) { var gv = Gb[i] / norm; G[i] = clamp(gv * 3, 0, 1); GD[i] = clamp((gv - 0.85) / 0.12, 0, 1); }
    var fxs = (sw - 1) / Math.max(1, w - 1), fys = (sh - 1) / Math.max(1, h - 1);
    for (y = 0; y < h; y++) {
      var fy = (y + 0.5) / sc - 0.5; fy = clamp(fy, 0, sh - 1); var y0 = fy | 0, y1 = y0 + 1 < sh ? y0 + 1 : y0, ty = fy - y0;
      for (x = 0; x < w; x++) {
        var fx = (x + 0.5) / sc - 0.5; fx = clamp(fx, 0, sw - 1); var x0 = fx | 0, x1 = x0 + 1 < sw ? x0 + 1 : x0, tx = fx - x0;
        var q00 = y0 * sw + x0, q01 = y0 * sw + x1, q10 = y1 * sw + x0, q11 = y1 * sw + x1;
        var w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        var g = G[q00] * w00 + G[q01] * w01 + G[q10] * w10 + G[q11] * w11;
        if (g <= 0.001) continue;
        var gd = GD[q00] * w00 + GD[q01] * w01 + GD[q10] * w10 + GD[q11] * w11;
        var j2 = (y * w + x) * 4, e0 = [0, 0, 0], dd2 = 0;
        for (c = 0; c < 3; c++) {
          var bv = B2[c][q00] * w00 + B2[c][q01] * w01 + B2[c][q10] * w10 + B2[c][q11] * w11;
          e0[c] = bv; var df = d[j2 + c] - bv; dd2 += df * df;
        }
        var dist2 = Math.sqrt(dd2), al = 1 - smooth(18, 95, dist2);
        al *= g;
        if (gd > al) al = gd;
        if (al <= 0) continue;
        var flat = smooth(0.8, 1, al);
        for (c = 0; c < 3; c++) {
          var nv = d[j2 + c] + al * (tg[c] - e0[c]);
          d[j2 + c] = nv + (tg[c] - nv) * flat;
        }
      }
    }
    return { found: true, share: share, color: tg.map(Math.round) };
  }

  /* the whole pipeline, in the order that gives the cleanest result */
  function run(src, w, h, p, progress, own) {
    var d = own ? src : new Uint8ClampedArray(src);
    var n = w * h, info = {};
    var faces = p.faceMode > 0 && p.faces && p.faces.length ? p.faces : [];
    var crops = [];
    if (p.fade > 0) info.levels = autoLevels(d, n, p.fade / 100);
    if (progress) progress(0.02);
    for (var i = 0; i < faces.length; i++) crops.push(faceCrop(d, w, h, faces[i]));
    var main = enhance(d, w, h, p, progress ? function (f) { progress(0.02 + 0.9 * f); } : null);
    info.dust = main.info.dust;
    var s = main.w / w;
    if (crops.length) {
      var fp = {
        dust: p.faceMode === 2 ? 0 : p.dust * 0.6, color: 0, scale: p.scale, refLong: Math.max(w, h), fade: 0,
        noise: p.faceMode === 2 ? 0 : p.noise * 0.4,
        sharp: p.faceMode === 2 ? 0 : p.sharp * 0.5,
        bump: p.faceMode !== 2,
        shock: p.faceMode !== 2
      };
      var done = 0;
      for (var c = 0; c < crops.length; c++) {
        if (!crops[c]) continue;
        fp.dustSkip = crops[c].skip;
        var B = enhance(crops[c].data, crops[c].cw, crops[c].ch, fp, null);
        blendFace(main.d, main.w, main.h, B.d, B.w, B.h, crops[c], s, faces[c]);
        done++;
        if (progress) progress(0.92 + 0.08 * (c + 1) / crops.length);
      }
      info.faces = done;
    }
    if (p.bg > 0) info.bg = cleanBackground(main.d, main.w, main.h, p.bg, p.bgColor);
    return { data: main.d, w: main.w, h: main.h, info: info };
  }

  /* Face finder: an LBP cascade (the model is passed in by the page). It looks for frontal
     faces on a reduced copy of the photo and returns ellipses that also cover hair and chin.
     It is approximate, so the page lets people add or remove areas by hand. */
  var faceModel = null;

  function detect(d, w, h, minN) {
    var m = faceModel;
    if (!m) return [];
    var k = Math.max(1, Math.ceil(Math.max(w, h) / 800));
    var sw = Math.floor(w / k), sh = Math.floor(h / k);
    if (sw < 48 || sh < 48) return [];
    var iw = sw + 1, I = new Int32Array(iw * (sh + 1)), kk = k * k, x, y, xx, yy;
    for (y = 0; y < sh; y++) {
      var row = 0;
      for (x = 0; x < sw; x++) {
        var sum = 0;
        for (yy = 0; yy < k; yy++) for (xx = 0; xx < k; xx++) {
          var j = ((y * k + yy) * w + x * k + xx) * 4;
          sum += d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29;
        }
        row += Math.round(sum / kk / 256);
        I[(y + 1) * iw + x + 1] = I[y * iw + x + 1] + row;
      }
    }
    var F = m.f, S = m.s, nf = F.length, hits = [];
    var offs = new Int32Array(nf * 16);
    for (var sc = 1; m.w * sc <= Math.min(sw, sh) * 0.98; sc *= 1.2) {
      var ws = Math.round(m.w * sc), hs = Math.round(m.h * sc), step = Math.max(2, Math.round(sc));
      for (var f = 0; f < nf; f++) {
        var fx = Math.round(F[f][0] * sc), fy = Math.round(F[f][1] * sc);
        var cw = Math.max(1, Math.round(F[f][2] * sc)), ch = Math.max(1, Math.round(F[f][3] * sc));
        for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) offs[f * 16 + r * 4 + c] = (fy + r * ch) * iw + fx + c * cw;
      }
      for (y = 0; y + hs <= sh; y += step) {
        for (x = 0; x + ws <= sw; x += step) {
          var base = y * iw + x, pass = true;
          for (var si = 0; si < S.length && pass; si++) {
            var nodes = S[si].n, acc = 0;
            for (var ni = 0; ni < nodes.length; ni++) {
              var nd = nodes[ni], o = nd[0] * 16;
              // 16 corner values of the 4 x 4 grid
              var g = [I[base + offs[o]], I[base + offs[o + 1]], I[base + offs[o + 2]], I[base + offs[o + 3]],
                       I[base + offs[o + 4]], I[base + offs[o + 5]], I[base + offs[o + 6]], I[base + offs[o + 7]],
                       I[base + offs[o + 8]], I[base + offs[o + 9]], I[base + offs[o + 10]], I[base + offs[o + 11]],
                       I[base + offs[o + 12]], I[base + offs[o + 13]], I[base + offs[o + 14]], I[base + offs[o + 15]]];
              var cv = g[10] - g[6] - g[9] + g[5];
              var code = (g[5] - g[1] - g[4] + g[0] >= cv ? 128 : 0) | (g[6] - g[2] - g[5] + g[1] >= cv ? 64 : 0) |
                         (g[7] - g[3] - g[6] + g[2] >= cv ? 32 : 0) | (g[11] - g[7] - g[10] + g[6] >= cv ? 16 : 0) |
                         (g[15] - g[11] - g[14] + g[10] >= cv ? 8 : 0) | (g[14] - g[10] - g[13] + g[9] >= cv ? 4 : 0) |
                         (g[13] - g[9] - g[12] + g[8] >= cv ? 2 : 0) | (g[9] - g[5] - g[8] + g[4] >= cv ? 1 : 0);
              acc += (nd[1 + (code >> 5)] & (1 << (code & 31))) ? nd[9] : nd[10];
            }
            if (acc < S[si].t) pass = false;
          }
          if (pass) hits.push([x, y, ws, hs]);
        }
      }
    }
    // merge overlapping hits; a real face is hit many times
    var cl = [];
    for (var i = 0; i < hits.length; i++) {
      var hh = hits[i], placed = false;
      for (var ci = 0; ci < cl.length; ci++) {
        var cc = cl[ci], mx = cc.x / cc.n, my = cc.y / cc.n, mw = cc.w / cc.n, mh = cc.h / cc.n;
        var ox = Math.min(hh[0] + hh[2], mx + mw) - Math.max(hh[0], mx), oy = Math.min(hh[1] + hh[3], my + mh) - Math.max(hh[1], my);
        if (ox > 0 && oy > 0) {
          var inter = ox * oy, uni = hh[2] * hh[3] + mw * mh - inter;
          if (inter / uni > 0.3) { cc.x += hh[0]; cc.y += hh[1]; cc.w += hh[2]; cc.h += hh[3]; cc.n++; placed = true; break; }
        }
      }
      if (!placed) cl.push({ x: hh[0], y: hh[1], w: hh[2], h: hh[3], n: 1 });
    }
    var need = minN || 4, out = [];
    for (var a = 0; a < cl.length; a++) {
      var e = cl[a]; if (e.n < need) continue;
      out.push({ x: e.x / e.n, y: e.y / e.n, w: e.w / e.n, h: e.h / e.n, n: e.n });
    }
    out.sort(function (p, q) { return q.n - p.n; });
    var keep = [];
    for (var b = 0; b < out.length && keep.length < 8; b++) {
      var r0 = out[b], inside = false;
      for (var c2 = 0; c2 < keep.length; c2++) {
        var kp = keep[c2], cx0 = r0.x + r0.w / 2, cy0 = r0.y + r0.h / 2;
        if (cx0 > kp.x && cx0 < kp.x + kp.w && cy0 > kp.y && cy0 < kp.y + kp.h) { inside = true; break; }
      }
      if (!inside) keep.push(r0);
    }
    return keep.map(function (r) {
      return { cx: (r.x + r.w / 2) * k, cy: (r.y + r.h / 2) * k, rx: r.w * 0.62 * k, ry: r.h * 0.72 * k, n: r.n };
    });
  }

  self.__engine = { setModel: function (m) { faceModel = m; }, run: run, enhance: enhance, detect: detect, shock: shock, autoLevels: autoLevels, removeDust: removeDust, denoise: denoise, upscale: upscale, sharpen: sharpen, vibrance: vibrance };

  self.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.type === 'init') {
        base = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.data) };
        self.postMessage({ type: 'ready' });
      } else if (m.type === 'model') {
        faceModel = m.model;
        self.postMessage({ type: 'model-ok' });
      } else if (m.type === 'detect') {
        self.postMessage({ type: 'faces', id: m.id, faces: detect(base.data, base.w, base.h), w: base.w, h: base.h });
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
