/* AI face step, run in a worker so the page stays usable.
   It does two jobs with ONNX Runtime Web (WebAssembly, single thread):
     detect  - find faces and their five landmarks (SCRFD 2.5g, a small face detector)
     restore - run a face-restoration network (GPEN-BFR, 256 or 512 px) on an aligned face crop
   Nothing leaves the device. The page decides how the result is blended back. */
'use strict';
var ort = null, det = null, face = null, faceSize = 256;

function post(m, tr) { self.postMessage(m, tr || []); }

async function init(m) {
  importScripts(m.base + 'vendor/ort/ort.wasm.min.js');
  ort = self.ort;
  ort.env.wasm.wasmPaths = m.base + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;      // threads need a cross-origin-isolated page; one thread works everywhere
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  det = await ort.InferenceSession.create(new Uint8Array(m.det), { executionProviders: ['wasm'], logSeverityLevel: 3 });
}

async function loadFace(m) {
  face = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  var sz = 0;
  try { sz = face.inputMetadata[0].shape[2]; } catch (_) { /* older runtimes: read it from the first run */ }
  faceSize = typeof sz === 'number' && sz > 0 ? sz : 0;
  if (!faceSize) {      // find out by trying
    var sizes = [256, 512];
    for (var i = 0; i < sizes.length && !faceSize; i++) {
      try { await face.run({ [face.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * sizes[i] * sizes[i]), [1, 3, sizes[i], sizes[i]]) }); faceSize = sizes[i]; } catch (_) { /* wrong size */ }
    }
    if (!faceSize) throw new Error('This model does not take a 256 or 512 px face crop.');
  }
}

/* SCRFD: three strides, two anchors per cell, boxes and 5 landmarks as distances from the anchor */
function nms(c, thr) {
  c.sort(function (a, b) { return b.score - a.score; });
  var keep = [];
  for (var i = 0; i < c.length; i++) {
    var ok = true;
    for (var j = 0; j < keep.length; j++) {
      var a = c[i].box, b = keep[j].box;
      var ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
      var inter = ix * iy, ua = (a[2] - a[0] + 1) * (a[3] - a[1] + 1) + (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - inter;
      if (inter / ua > thr) { ok = false; break; }
    }
    if (ok) keep.push(c[i]);
  }
  return keep;
}

async function detect(m) {
  var w = m.w, h = m.h, d = m.data, S = 640;
  // the page sends the photo already resized to fit 640; it sits top-left on a black 640x640 canvas
  var t = new Float32Array(3 * S * S), plane = S * S;
  for (var i = 0; i < plane; i++) { t[i] = -127.5 / 128; t[plane + i] = -127.5 / 128; t[2 * plane + i] = -127.5 / 128; }
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var j = (y * w + x) * 4, o = y * S + x;
    t[o] = (d[j] - 127.5) / 128; t[plane + o] = (d[j + 1] - 127.5) / 128; t[2 * plane + o] = (d[j + 2] - 127.5) / 128;
  }
  var out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, S, S]) });
  var names = det.outputNames, strides = [8, 16, 32], cand = [];
  for (var k = 0; k < 3; k++) {
    var sc_ = out[names[k]].data, bb = out[names[k + 3]].data, kp = out[names[k + 6]].data, st = strides[k], fw = S / st;
    for (var n = 0; n < sc_.length; n++) {
      if (sc_[n] < 0.4) continue;
      var cell = n >> 1, cx = (cell % fw) * st, cy = ((cell / fw) | 0) * st;
      var pts = [];
      for (var q = 0; q < 5; q++) pts.push([(cx + kp[n * 10 + q * 2] * st), (cy + kp[n * 10 + q * 2 + 1] * st)]);
      cand.push({ score: sc_[n], box: [cx - bb[n * 4] * st, cy - bb[n * 4 + 1] * st, cx + bb[n * 4 + 2] * st, cy + bb[n * 4 + 3] * st], kps: pts });
    }
  }
  return nms(cand, 0.4).slice(0, 6).map(function (f) { return { score: f.score, box: f.box, kps: f.kps }; });
}

/* the crop arrives aligned, as RGBA; the network works on RGB in [-1, 1] */
async function restore(m) {
  var size = m.size, d = m.data, plane = size * size;
  var t = new Float32Array(3 * plane);
  for (var i = 0, j = 0; i < plane; i++, j += 4) {
    t[i] = d[j] / 127.5 - 1; t[plane + i] = d[j + 1] / 127.5 - 1; t[2 * plane + i] = d[j + 2] / 127.5 - 1;
  }
  var res = await face.run({ [face.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, size, size]) });
  var y = res[face.outputNames[0]].data, outp = new Uint8ClampedArray(plane * 4);
  for (var p = 0, q = 0; p < plane; p++, q += 4) {
    outp[q] = (Math.max(-1, Math.min(1, y[p])) + 1) * 127.5;
    outp[q + 1] = (Math.max(-1, Math.min(1, y[plane + p])) + 1) * 127.5;
    outp[q + 2] = (Math.max(-1, Math.min(1, y[2 * plane + p])) + 1) * 127.5;
    outp[q + 3] = 255;
  }
  return outp;
}

self.onmessage = async function (e) {
  var m = e.data;
  try {
    if (m.type === 'init') { await init(m); post({ type: 'ready' }); }
    else if (m.type === 'model') { await loadFace(m); post({ type: 'model', size: faceSize }); }
    else if (m.type === 'detect') { var f = await detect(m); post({ type: 'faces', id: m.id, faces: f }); }
    else if (m.type === 'restore') {
      var o = await restore(m);
      post({ type: 'restored', id: m.id, size: m.size, data: o.buffer }, [o.buffer]);
    }
  } catch (err) { post({ type: 'error', id: m.id, stage: m.type, message: String(err && err.message || err) }); }
};
