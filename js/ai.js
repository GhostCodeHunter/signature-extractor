/* Page side of the AI face step: loads the worker and the models, finds faces, aligns each one to the
   layout the face network expects, and returns the network's output so the engine can blend it back.
   Models come from this site's /models folder (as one .onnx file, or as numbered pieces (named .wasm, the one binary type the artifact host serves) where a host
   will not serve .onnx or caps the size of a file), then from a file the person picks. A model that has been
   fetched or picked is kept in the browser's cache storage when the page is allowed to use it. */
(function () {
  'use strict';
  var SX = window.SX = window.SX || {};

  var DET_URLS = ['models/scrfd_2.5g.onnx', ['models/scrfd_2.5g.part1.wasm']];
  var FACE_URLS = ['models/gpen_bfr_256.onnx', ['models/gpen_bfr_256.part1.wasm', 'models/gpen_bfr_256.part2.wasm', 'models/gpen_bfr_256.part3.wasm', 'models/gpen_bfr_256.part4.wasm']];
  var CACHE = 'sx-ai-models-v1', USER_KEY = 'https://sx.local/user-face-model';
  // where the eyes, nose and mouth corners sit in a 512 px face crop (the layout these networks were trained on)
  var TPL = [[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]];

  var worker = null, pending = {}, ready = null, modelPromise = null;
  var ai = SX.ai = { size: 0, source: '' };

  function abs(u) { return new URL(u, document.baseURI).href; }
  async function openCache() { try { return await caches.open(CACHE); } catch (_) { return null; } }

  async function fetchBuffer(url, onProgress, skipCache) {
    var cache = skipCache ? null : await openCache(), key = abs(url);
    if (cache) { var hit = await cache.match(key); if (hit) return hit.arrayBuffer(); }
    var res = await fetch(key);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (/text\/html/.test(res.headers.get('content-type') || '')) throw new Error('not a model file');
    var total = +res.headers.get('content-length') || 0, got = 0, chunks = [], reader = res.body && res.body.getReader();
    if (!reader) { var whole = await res.arrayBuffer(); chunks = [new Uint8Array(whole)]; got = whole.byteLength; }
    else for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value); got += r.value.length;
      if (onProgress && total) onProgress(got / total);
    }
    var buf = new Uint8Array(got), o = 0;
    chunks.forEach(function (c) { buf.set(c, o); o += c.length; });
    if (got < 1e6) throw new Error('too small to be a model');
    if (cache) { try { await cache.put(key, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) { /* storage full or blocked: fine */ } }
    return buf.buffer;
  }

  /* one file, or a list of pieces to be joined (the first piece's address is the cache key for the whole) */
  async function fetchSpec(spec, onProgress) {
    if (typeof spec === 'string') return fetchBuffer(spec, onProgress);
    var cache = await openCache(), key = abs(spec[0]);
    if (cache) { var hit = await cache.match(key); if (hit) return hit.arrayBuffer(); }
    var parts = [], total = 0, i;
    for (i = 0; i < spec.length; i++) {
      var p = await fetchBuffer(spec[i], onProgress && function (f) { onProgress((i + f) / spec.length); }, true);
      parts.push(new Uint8Array(p)); total += p.byteLength;
    }
    var out = new Uint8Array(total), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    if (cache) { try { await cache.put(key, new Response(out.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) { /* fine */ } }
    return out.buffer;
  }

  function call(msg, transfer) {
    return new Promise(function (res, rej) {
      pending[msg.type + (msg.id || '')] = { res: res, rej: rej };
      worker.postMessage(msg, transfer || []);
    });
  }
  function onMessage(e) {
    var m = e.data, key = null;
    if (m.type === 'ready') key = 'init';
    else if (m.type === 'model') key = 'model';
    else if (m.type === 'faces') key = 'detect' + m.id;
    else if (m.type === 'restored') key = 'restore' + m.id;
    else if (m.type === 'error') key = m.stage + (m.id || '');
    var p = key && pending[key]; if (!p) return;
    delete pending[key];
    if (m.type === 'error') p.rej(new Error(m.message)); else p.res(m);
  }

  async function makeWorker() {
    var base = abs('.'), code = null;
    try { code = await (await fetch(abs('js/aiworker.js'))).text(); } catch (_) { /* use the file URL below */ }
    try {
      worker = code ? new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))) : new Worker(abs('js/aiworker.js'));
    } catch (_) { worker = new Worker(abs('js/aiworker.js')); }
    worker.onmessage = onMessage;
    worker.onerror = function (e) { Object.keys(pending).forEach(function (k) { pending[k].rej(new Error(e.message || 'worker error')); delete pending[k]; }); };
    var det = null;
    for (var i = 0; !det && i < DET_URLS.length; i++) { try { det = await fetchSpec(DET_URLS[i]); } catch (_) { det = null; } }
    if (!det) throw new Error('model-missing');
    await call({ type: 'init', base: base, det: det }, [det]);
  }

  function ensureRuntime() {
    if (!ready) ready = makeWorker().catch(function (e) { ready = null; if (worker) { worker.terminate(); worker = null; } throw e; });
    return ready;
  }

  /* Load the runtime and a face model. onProgress gets 0..1 while the model downloads. */
  ai.load = function (onProgress) {
    if (ai.size) return Promise.resolve();
    if (modelPromise) return modelPromise;
    modelPromise = (async function () {
      await ensureRuntime();
      var buf = null, cache = await openCache();
      if (cache) { var u = await cache.match(USER_KEY); if (u) { buf = await u.arrayBuffer(); ai.source = 'the file you chose'; } }
      for (var i = 0; !buf && i < FACE_URLS.length; i++) {
        try { buf = await fetchSpec(FACE_URLS[i], onProgress); ai.source = String(FACE_URLS[i]); } catch (_) { buf = null; }
      }
      if (!buf) throw new Error('model-missing');
      var r = await call({ type: 'model', model: buf }, [buf]);
      ai.size = r.size;
    })().catch(function (e) { modelPromise = null; throw e; });
    return modelPromise;
  };

  /* A model file the person picked (GPEN-BFR 256 or 512). It is kept for next time. */
  ai.useFile = async function (file) {
    var buf = await file.arrayBuffer();
    var cache = await openCache();
    if (cache) { try { await cache.put(USER_KEY, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) { /* ignore */ } }
    await ensureRuntime();
    var r = await call({ type: 'model', model: buf }, [buf]);
    ai.size = r.size; ai.source = 'the file you chose'; modelPromise = Promise.resolve();
  };

  /* the similarity transform (rotation, scale, shift) that carries the five landmarks onto the template */
  function align(kps, size) {
    var k = size / 512, n = 5, i, mpx = 0, mpy = 0, mqx = 0, mqy = 0;
    var Q = TPL.map(function (t) { return [t[0] * k, t[1] * k]; });
    for (i = 0; i < n; i++) { mpx += kps[i][0]; mpy += kps[i][1]; mqx += Q[i][0]; mqy += Q[i][1]; }
    mpx /= n; mpy /= n; mqx /= n; mqy /= n;
    var den = 0, na = 0, nb = 0;
    for (i = 0; i < n; i++) {
      var px = kps[i][0] - mpx, py = kps[i][1] - mpy, qx = Q[i][0] - mqx, qy = Q[i][1] - mqy;
      den += px * px + py * py; na += px * qx + py * qy; nb += px * qy - py * qx;
    }
    var a = na / den, b = nb / den;
    return [a, -b, mqx - (a * mpx - b * mpy), b, a, mqy - (b * mpx + a * mpy)];     // x' = a x - b y + tx ; y' = b x + a y + ty
  }

  /* Find faces in a canvas. Returns landmarks and boxes in the canvas' own pixels, biggest first. */
  ai.detect = async function (canvas) {
    await ensureRuntime();
    var sc = Math.min(640 / canvas.width, 640 / canvas.height), w = Math.max(32, Math.round(canvas.width * sc)), h = Math.max(32, Math.round(canvas.height * sc));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var cx = c.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(canvas, 0, 0, w, h);
    var data = cx.getImageData(0, 0, w, h).data;
    var id = 'd' + Date.now();
    var r = await call({ type: 'detect', id: id, w: w, h: h, data: data }, []);
    var fx = canvas.width / w, fy = canvas.height / h;
    return r.faces.filter(function (f) { return f.score >= 0.5; }).map(function (f) {
      return { score: f.score, box: [f.box[0] * fx, f.box[1] * fy, f.box[2] * fx, f.box[3] * fy], kps: f.kps.map(function (p) { return [p[0] * fx, p[1] * fy]; }) };
    }).sort(function (p, q) { return (q.box[2] - q.box[0]) * (q.box[3] - q.box[1]) - (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]); });
  };

  /* Cut an aligned crop out of the full-size photo, run the network on it, and hand back the result together
     with the transform (photo pixels to crop pixels) the engine needs to put it back. */
  ai.restoreFace = async function (canvas, face) {
    var size = ai.size || 256, M = align(face.kps, size);
    var c = document.createElement('canvas'); c.width = c.height = size;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = 'rgb(135,133,132)'; cx.fillRect(0, 0, size, size);
    cx.imageSmoothingQuality = 'high';
    cx.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]);
    cx.drawImage(canvas, 0, 0);
    var crop = cx.getImageData(0, 0, size, size).data;
    var id = 'r' + Date.now() + Math.random().toString(36).slice(2, 6);
    var r = await call({ type: 'restore', id: id, size: size, data: crop }, []);
    return { M: M, size: size, data: new Uint8ClampedArray(r.data) };
  };
})();
