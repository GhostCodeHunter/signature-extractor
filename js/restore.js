(() => {
'use strict';

const { $, $$, clamp } = SX;
const toast = SX.toast;
const PREVIEW_SIDE = 1600;     // the live preview is a copy no longer than this
const SRC_MAX_SIDE = 6000;     // longest side of a photo we open
const SRC_MAX_PIXELS = 24e6;   // largest photo we open
const OUT_MAX_PIXELS = 36e6;   // largest file we create

const PRESETS = {
  auto:     { fade: 60, dust: 40, noise: 35, sharp: 45, color: 15 },
  faded:    { fade: 90, dust: 60, noise: 45, sharp: 40, color: 35 },
  phone:    { fade: 35, dust: 10, noise: 40, sharp: 55, color: 20 },
  lowlight: { fade: 50, dust: 20, noise: 70, sharp: 35, color: 25 },
  id:       { fade: 100, dust: 30, noise: 55, sharp: 40, color: 10, bg: 1, scale: 4, ai: 1 },   // the only preset that also sets a backdrop, a size and the AI face step
};
const KEYS = ['fade', 'dust', 'noise', 'sharp', 'color'];

const el = {
  intro: $('#r-intro'), drop: $('#r-drop'), file: $('#r-file'), sample: $('#r-sample'),
  work: $('#r-work'), status: $('#r-status'), cmp: $('#r-cmp'), wait: $('#r-wait'),
  before: $('#r-before'), after: $('#r-after'), faces: $('#r-faces'),
  presets: $('#r-presets'), size: $('#r-size'), download: $('#r-download'), again: $('#r-again'),
  ai: $('#r-ai'), aiAmt: $('#r-aiAmt'), aiAmtOut: $('#r-aiAmtOut'), aiAmtWrap: $('#r-ai-amt'), aiNote: $('#r-ai-note'), aiFile: $('#r-ai-file'), aiPick: $('#r-ai-pick'),
  bg: $('#r-bg'), bgCustom: $('#r-bg-custom'), bgColor: $('#r-bg-color'), bgNote: $('#r-bg-note'),
  faceNote: $('#r-face-note'), faceMark: $('#r-face-mark'), faceClear: $('#r-face-clear'), steps: $('#r-steps'),
};
const sliders = {}, outs = {};
KEYS.forEach((k) => { sliders[k] = $('#r-' + k); outs[k] = $('#r-' + k + 'Out'); });

const S = {
  w: 0, h: 0, src: null, pw: 0, ph: 0, name: 'photo',
  worker: null, ready: false, busy: false, queued: false, seq: 0, pid: 0,
  exporting: false, maxScale: 1, loading: false,
  faces: [],            // { cx, cy, rx, ry } as fractions of the photo's width and height
  marking: false,
  bg: 0,                // 0 keep, 1 sky blue, 2 blue, 3 white, 4 grey, 5 the picked colour
  aiOn: false, aiFaces: null, aiToken: 0,
};

const scaleSeg = SX.seg($('#r-scale'), () => { updateSize(); SX.steps(el.steps, 2); requestPreview(); });
const fmtSeg = SX.seg($('#r-format'));
const aiSeg = SX.seg($('#r-ai'), (v) => { if (v === '1') startAi(); else stopAi(); SX.steps(el.steps, 2); });
const faceSeg = SX.seg($('#r-face'), () => { renderFaces(); updateFaceNote(); requestPreview(); });
const cmp = SX.compare(el.cmp);

/* ---------- worker ---------- */
function makeWorker() {
  const code = '(' + restoreEngineWorker.toString() + ')();';
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const w = new Worker(url);
  w._url = url;
  return w;
}
function killWorker(w) { if (!w) return; try { w.terminate(); } catch (_) {} if (w._url) URL.revokeObjectURL(w._url); }

/* ---------- opening a photo ---------- */
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
}

async function loadFile(file, opts) {
  if (S.loading) return;
  if (!file || !/^image\//.test(file.type)) { toast('That file is not an image. Choose a JPG or PNG photo.', true); return; }
  S.loading = true;
  SX.dropBusy(el.drop, true);
  SX.progress.start();
  try {
    await new Promise((r) => setTimeout(r, 30));
    let bmp;
    try { bmp = await decode(file); } catch (e) { toast("This photo couldn't be opened. Try a JPG or PNG.", true); return; }
    const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
    let f = 1;
    if (Math.max(bw, bh) > SRC_MAX_SIDE) f = SRC_MAX_SIDE / Math.max(bw, bh);
    if (bw * bh * f * f > SRC_MAX_PIXELS) f = Math.min(f, Math.sqrt(SRC_MAX_PIXELS / (bw * bh)));
    const W = Math.max(1, Math.round(bw * f)), H = Math.max(1, Math.round(bh * f));

    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);   // transparent PNGs are flattened onto white
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();

    const pf = Math.min(1, PREVIEW_SIDE / Math.max(W, H));
    const pw = Math.max(1, Math.round(W * pf)), ph = Math.max(1, Math.round(H * pf));
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph;
    const px = pc.getContext('2d', { willReadFrequently: true });
    px.imageSmoothingQuality = 'high';
    px.drawImage(c, 0, 0, pw, ph);
    const pdata = px.getImageData(0, 0, pw, ph);

    S.w = W; S.h = H; S.src = c; S.pw = pw; S.ph = ph; S.pcanvas = pc;
    S.name = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'photo';
    S.faces = []; setMarking(false);

    for (const cv of [el.before, el.after]) { cv.width = pw; cv.height = ph; }
    el.before.getContext('2d').drawImage(pc, 0, 0);
    el.after.getContext('2d').drawImage(pc, 0, 0);
    el.cmp.style.setProperty('--ar', String(pw / ph));
    cmp.set(50);

    stopAi(true);
    setBg(0, true);
    applyPreset((opts && opts.preset) || 'auto', true);
    faceSeg.set('1');
    renderFaces(); updateFaceNote();
    setScaleLimits();
    scaleSeg.set('1');
    updateSize();

    killWorker(S.worker);
    S.ready = false; S.busy = false; S.queued = false;
    try {
      S.worker = makeWorker();
    } catch (e) {
      toast("This browser can't run the restore engine. Try a recent Chrome, Edge, Safari or Firefox.", true);
      return;
    }
    S.worker.onmessage = onMessage;
    S.worker.onerror = () => { S.busy = false; showStatus(false); toast('Something went wrong while restoring. Try a smaller photo.', true); };
    const buf = pdata.data.buffer;
    S.worker.postMessage({ type: 'init', w: pw, h: ph, data: buf }, [buf]);

    SX.hideToast();
    if (f < 1) toast('Large photo reduced to ' + W + ' × ' + H + ' px to fit in the browser.');
    SX.steps(el.steps, 2);
    await SX.swap(el.intro, el.work);
  } finally {
    S.loading = false;
    SX.dropBusy(el.drop, false);
    SX.progress.done();
  }
}

/* ---------- live preview ---------- */
let statusTimer = 0;
function showStatus(on) {
  clearTimeout(statusTimer);
  if (on) statusTimer = setTimeout(() => { el.status.classList.add('on'); el.wait.classList.add('on'); }, 220);
  else { el.status.classList.remove('on'); el.wait.classList.remove('on'); }
}
function faceList(W, H) {
  return S.faces.map((f) => ({ cx: f.cx * W, cy: f.cy * H, rx: f.rx * W, ry: f.ry * H }));
}
function readParams(W, H) {
  const p = { scale: +scaleSeg.value() || 1, faceMode: +faceSeg.value() || 0, faces: faceList(W, H), bg: S.bg };
  if (S.bg === 5) { const v = parseInt(el.bgColor.value.slice(1), 16); p.bgColor = [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  KEYS.forEach((k) => { p[k] = +sliders[k].value; });
  if (S.aiOn && S.aiFaces && S.aiFaces.length) {
    const k = W / S.w;      // the faces were measured on the full-size photo; this step may be working on a smaller copy
    p.ai = S.aiFaces.map((f) => ({ size: f.size, data: f.data, M: [f.M[0] / k, f.M[1] / k, f.M[2], f.M[3] / k, f.M[4] / k, f.M[5]] }));
    p.aiAmount = +el.aiAmt.value;
  }
  return p;
}
function requestPreview() {
  if (!S.ready || S.busy) { S.queued = true; return; }
  runPreview();
}
function runPreview() {
  S.busy = true; S.queued = false; S.pid = ++S.seq;
  showStatus(true);
  const p = readParams(S.pw, S.ph);
  // the preview is a copy of at most PREVIEW_SIDE px; a small photo is previewed at the size picked, so what is on screen is what will be saved
  const want = +scaleSeg.value() || 1, room = PREVIEW_SIDE / Math.max(S.pw, S.ph);
  p.scale = [8, 4, 2, 1].find((s) => s <= want && s <= room + 1e-6) || 1;
  S.worker.postMessage({ type: 'run', id: S.pid, params: p });
}
function onMessage(e) {
  const m = e.data;
  if (m.type === 'ready') { S.ready = true; runPreview(); findFaces(); return; }
  if (m.type === 'faces') { setFaces(m.faces, m.w, m.h); return; }
  if (m.type === 'error') { S.busy = false; showStatus(false); toast('Something went wrong while restoring. Try a smaller photo.', true); return; }
  if (m.type !== 'done') return;
  if (m.id === S.pid) {
    if (el.after.width !== m.w || el.after.height !== m.h) { el.after.width = m.w; el.after.height = m.h; }
    el.after.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data), m.w, m.h), 0, 0);
    updateBgNote(m.info);
  }
  S.busy = false;
  if (S.queued) runPreview(); else showStatus(false);
}

/* ---------- faces ---------- */
async function findFaces() {
  const pc = S.pcanvas;
  if ('FaceDetector' in window) {
    try {
      const found = await new window.FaceDetector({ fastMode: false, maxDetectedFaces: 8 }).detect(pc);
      if (found.length) {
        setFaces(found.map((r) => {
          const b = r.boundingBox;
          return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, rx: b.width * 0.62, ry: b.height * 0.72 };
        }), S.pw, S.ph);
        return;
      }
    } catch (_) { /* fall back to the built-in finder */ }
  }
  if (!S.worker || typeof FACE_MODEL === 'undefined') return;
  S.worker.postMessage({ type: 'model', model: FACE_MODEL });
  S.worker.postMessage({ type: 'detect', id: S.seq });
}
function setFaces(list, w, h) {
  S.faces = list.map((f) => ({ cx: f.cx / w, cy: f.cy / h, rx: f.rx / w, ry: f.ry / h }));
  renderFaces(); updateFaceNote();
  if (S.faces.length && +faceSeg.value() > 0) requestPreview();
}
function renderFaces() {
  el.faces.textContent = '';
  const show = S.marking || +faceSeg.value() > 0;
  el.faces.hidden = !show;
  if (!show) return;
  S.faces.forEach((f) => {
    const d = document.createElement('div');
    d.className = 'fz';
    d.style.cssText = 'left:' + (f.cx - f.rx) * 100 + '%;top:' + (f.cy - f.ry) * 100 + '%;width:' + f.rx * 200 + '%;height:' + f.ry * 200 + '%';
    el.faces.appendChild(d);
  });
  el.faceClear.hidden = S.faces.length === 0;
}
function updateFaceNote() {
  const mode = +faceSeg.value(), n = S.faces.length;
  let t;
  if (mode === 0) t = 'Faces are processed like the rest of the photo.';
  else if (!n) t = 'No faces found. If someone is in the photo, use Mark a face. Faces are never redrawn.';
  else t = n + (n === 1 ? ' face area' : ' face areas') + ' protected. ' + (mode === 1
    ? 'Gentle: lighter noise reduction and sharpening, no colour boost, and the eyes are left alone.'
    : 'Strict: tone correction and resizing only.') + ' Wrong area? Choose Mark a face, then click it to remove it.';
  el.faceNote.textContent = t;
  el.faceClear.hidden = n === 0;
}
function setMarking(on) {
  S.marking = on;
  el.cmp.classList.toggle('marking', on);
  el.faceMark.setAttribute('aria-pressed', String(on));
  el.faceMark.textContent = on ? 'Done marking' : 'Mark a face';
  if (on && +faceSeg.value() === 0) faceSeg.set('1');
  renderFaces(); updateFaceNote();
}
el.faceMark.addEventListener('click', () => {
  setMarking(!S.marking);
  if (S.marking) toast('Drag a box around a face on the photo. Click a box to remove it.');
});
el.faceClear.addEventListener('click', () => { S.faces = []; renderFaces(); updateFaceNote(); requestPreview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.marking) setMarking(false); });

let drag = null, tmp = null;
const norm = (e) => {
  const r = el.cmp.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
};
el.faces.addEventListener('pointerdown', (e) => {
  if (!S.marking) return;
  e.preventDefault();
  try { el.faces.setPointerCapture(e.pointerId); } catch (_) {}
  const p = norm(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false };
});
el.faces.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = norm(e);
  drag.x1 = p.x; drag.y1 = p.y;
  if (Math.abs(drag.x1 - drag.x0) > 0.012 || Math.abs(drag.y1 - drag.y0) > 0.012) drag.moved = true;
  if (!drag.moved) return;
  if (!tmp) { tmp = document.createElement('div'); tmp.className = 'fz temp'; el.faces.appendChild(tmp); }
  tmp.style.cssText = 'left:' + Math.min(drag.x0, drag.x1) * 100 + '%;top:' + Math.min(drag.y0, drag.y1) * 100 + '%;width:' + Math.abs(drag.x1 - drag.x0) * 100 + '%;height:' + Math.abs(drag.y1 - drag.y0) * 100 + '%';
});
el.faces.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (tmp) { tmp.remove(); tmp = null; }
  if (d.moved) {
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 0.03 || h < 0.03) return;
    S.faces.push({ cx: (d.x0 + d.x1) / 2, cy: (d.y0 + d.y1) / 2, rx: w / 2, ry: h / 2 });
  } else {
    const i = S.faces.findIndex((f) => ((d.x0 - f.cx) / f.rx) ** 2 + ((d.y0 - f.cy) / f.ry) ** 2 <= 1);
    if (i < 0) return;
    S.faces.splice(i, 1);
  }
  renderFaces(); updateFaceNote(); requestPreview();
});

/* ---------- controls ---------- */
function syncOutputs() { KEYS.forEach((k) => { outs[k].textContent = sliders[k].value; }); }
function setPressed(name) {
  $$('button', el.presets).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === name)));
}
const BG_HINT = 'Swaps an even backdrop for one flat colour, as ID and passport photos need. The person is left as they are.';
function updateBgNote(info) {
  const miss = S.bg > 0 && info && info.bg && info.bg.found === false;
  el.bgNote.textContent = miss ? 'No even backdrop was found along the top and sides, so the background was left as it is.' : BG_HINT;
}
function setBg(mode, silent) {
  S.bg = mode;
  $$('button[data-bg]', el.bg).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.bg === mode)));
  el.bgCustom.classList.toggle('on', mode === 5);
  if (!silent) requestPreview();
}
$$('button[data-bg]', el.bg).forEach((b) => b.addEventListener('click', () => { setBg(+b.dataset.bg); SX.steps(el.steps, 2); }));
el.bgColor.addEventListener('input', () => { setBg(5); SX.steps(el.steps, 2); });
el.bgCustom.addEventListener('click', (e) => { if (e.target !== el.bgColor) setBg(5); });

function applyPreset(name, silent) {
  const v = PRESETS[name]; if (!v) return;
  KEYS.forEach((k) => { sliders[k].value = v[k]; SX.fillRange(sliders[k]); });
  if (v.bg !== undefined) setBg(v.bg, true);
  if (v.scale) {      // the biggest size the photo allows, up to the one the preset asks for
    const sz = [8, 4, 2, 1].find((s) => s <= v.scale && s <= S.maxScale + 1e-6) || 1;
    scaleSeg.set(String(sz)); updateSize();
  }
  if (v.ai && !silent) { aiSeg.set('1'); startAi(); }
  syncOutputs(); setPressed(name);
  if (!silent) requestPreview();
}
KEYS.forEach((k) => {
  sliders[k].addEventListener('input', () => { outs[k].textContent = sliders[k].value; setPressed(null); SX.steps(el.steps, 2); requestPreview(); });
});
$$('button', el.presets).forEach((b) => b.addEventListener('click', () => { applyPreset(b.dataset.preset); SX.steps(el.steps, 2); }));

/* ---------- AI face detail ---------- */
const AI_HINT = 'Rebuilds the detail a small or blurry face has lost, using a face-restoration network that runs on this device. It can change small features, so compare the result with the original.';
function setAiNote(t) { el.aiNote.textContent = t; }
function stopAi(reset) {
  S.aiToken++; S.aiOn = false;
  if (reset) { S.aiFaces = null; aiSeg.set('0'); setAiNote(AI_HINT); el.aiPick.hidden = true; }
  el.aiAmtWrap.hidden = true;
  if (!reset) { setAiNote(AI_HINT); el.aiPick.hidden = true; requestPreview(); }
}
async function startAi() {
  if (!S.src) return;
  const token = ++S.aiToken;
  S.aiOn = true; S.aiFaces = null; el.aiPick.hidden = true;
  const live = () => token === S.aiToken;
  try {
    setAiNote('Loading the face model. The first time this downloads about 76 MB and keeps it for next time.');
    await SX.ai.load((f) => { if (live()) setAiNote('Downloading the face model, ' + Math.round(f * 100) + '%'); });
    if (!live()) return;
    setAiNote('Finding faces');
    const faces = await SX.ai.detect(S.src);
    if (!live()) return;
    if (!faces.length) { stopAi(true); setAiNote('No face was found in this photo, so nothing was added.'); return; }
    const use = faces.slice(0, 3), out = [];
    for (let i = 0; i < use.length; i++) {
      setAiNote('Rebuilding face detail' + (use.length > 1 ? ', face ' + (i + 1) + ' of ' + use.length : ''));
      out.push(await SX.ai.restoreFace(S.src, use[i]));
      if (!live()) return;
    }
    S.aiFaces = out;
    el.aiAmtWrap.hidden = false; SX.fillRange(el.aiAmt);
    setAiNote(out.length + (out.length > 1 ? ' faces' : ' face') + ' rebuilt. Lower the strength to stay closer to the original.');
    requestPreview();
  } catch (e) {
    if (!live()) return;
    stopAi(true);
    if (e && e.message === 'model-missing') {
      setAiNote('The face model could not be loaded here. It is a 76 MB file (gpen_bfr_256.onnx) that sits in the models folder of the project. If you have a copy, choose it and it will be used.');
      el.aiPick.hidden = false;
    } else {
      setAiNote('The face step could not run: ' + ((e && e.message) || 'unknown error') + '. The rest of the restore still works.');
      el.aiPick.hidden = false;
    }
  }
}
el.aiAmt.addEventListener('input', () => { el.aiAmtOut.textContent = el.aiAmt.value; SX.fillRange(el.aiAmt); SX.steps(el.steps, 2); requestPreview(); });
el.aiPick.addEventListener('click', () => el.aiFile.click());
el.aiFile.addEventListener('change', async () => {
  const f = el.aiFile.files && el.aiFile.files[0]; el.aiFile.value = '';
  if (!f) return;
  try { setAiNote('Reading the model file'); await SX.ai.useFile(f); aiSeg.set('1'); startAi(); }
  catch (e) { setAiNote('That file could not be used as a face model: ' + ((e && e.message) || 'unknown error')); }
});

function setScaleLimits() {
  S.maxScale = Math.sqrt(OUT_MAX_PIXELS / (S.w * S.h));
  scaleSeg.buttons.forEach((b) => {
    const off = +b.dataset.v > S.maxScale + 1e-6;
    if (off) { b.setAttribute('aria-disabled', 'true'); b.title = 'Over the ' + (OUT_MAX_PIXELS / 1e6) + ' megapixel limit for this photo'; }
    else { b.removeAttribute('aria-disabled'); b.removeAttribute('title'); }
  });
}
function updateSize() {
  const s = +scaleSeg.value() || 1;
  const ow = Math.round(S.w * s), oh = Math.round(S.h * s);
  el.size.textContent = ow + ' × ' + oh + ' px · ' + (ow * oh / 1e6).toFixed(1) + ' MP' + (S.maxScale < 8 ? '. Larger sizes are capped at ' + (OUT_MAX_PIXELS / 1e6) + ' MP.' : '');
}

/* ---------- download at full size ---------- */
el.download.addEventListener('click', async () => {
  if (S.exporting || !S.src) return;
  S.exporting = true;
  SX.busy(el.download, true, 'Preparing photo');
  SX.progress.start();
  let worker = null;
  try {
    const id = S.src.getContext('2d').getImageData(0, 0, S.w, S.h);
    const params = readParams(S.w, S.h);
    worker = makeWorker();
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { SX.busy(el.download, true, 'Processing ' + Math.round(m.p * 100) + '%'); SX.progress.set(m.p); }
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = () => reject(new Error('worker'));
      worker.postMessage({ type: 'run', id: 1, params, full: { w: S.w, h: S.h, data: id.data.buffer } }, [id.data.buffer]);
    });
    killWorker(worker); worker = null;
    SX.busy(el.download, true, 'Saving file');
    const out = document.createElement('canvas'); out.width = result.w; out.height = result.h;
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.data), result.w, result.h), 0, 0);
    const jpg = fmtSeg.value() === 'jpg';
    const blob = await new Promise((r) => out.toBlob(r, jpg ? 'image/jpeg' : 'image/png', 0.93));
    out.width = out.height = 1;
    if (!blob) throw new Error('encode');
    SX.busy(el.download, false);
    const ok = await SX.saveBlob(blob, S.name + '-restored.' + (jpg ? 'jpg' : 'png'));
    if (ok) { SX.flash(el.download, 'Downloaded'); SX.steps(el.steps, 3); }
  } catch (err) {
    killWorker(worker);
    SX.busy(el.download, false);
    toast("Couldn't process the photo at this size. Try a smaller size setting.", true);
  } finally {
    S.exporting = false;
    SX.progress.done();
  }
});

/* ---------- getting a file in ---------- */
el.file.addEventListener('change', () => { const f = el.file.files && el.file.files[0]; el.file.value = ''; if (f) loadFile(f); });
el.sample.addEventListener('click', async () => {
  try { loadFile(await SX.fetchFile('assets/sample-faded.jpg', 'sample-photo.jpg', 'image/jpeg'), { preset: 'faded' }); }
  catch (e) { toast("The sample isn't available when this page is opened from a file. Choose your own photo.", true); }
});
SX.tools.restore = { load: loadFile, over: (v) => el.drop.classList.toggle('over', v) };

el.again.addEventListener('click', async () => {
  setMarking(false);
  await SX.swap(el.work, el.intro);
  killWorker(S.worker); S.worker = null; S.ready = false; S.busy = false; S.queued = false;
  S.src = null; S.faces = [];
  showStatus(false);
  SX.steps(el.steps, 1);
});

syncOutputs();
updateFaceNote();
})();
