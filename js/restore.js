(() => {
'use strict';

const { $, $$, clamp } = SX;
const toast = SX.toast;
const PREVIEW_SIDE = 1600;   // the live preview is a copy no longer than this
const MAX_SIDE = 6000;       // longest side of a photo we will open
const MAX_PIXELS = 24e6;     // largest file we will create

const PRESETS = {
  auto:     { fade: 60, dust: 40, noise: 35, sharp: 45, color: 15 },
  faded:    { fade: 90, dust: 60, noise: 45, sharp: 40, color: 35 },
  phone:    { fade: 35, dust: 10, noise: 40, sharp: 55, color: 20 },
  lowlight: { fade: 50, dust: 20, noise: 70, sharp: 35, color: 25 },
};
const KEYS = ['fade', 'dust', 'noise', 'sharp', 'color'];

const el = {
  intro: $('#r-intro'), drop: $('#r-drop'), file: $('#r-file'), sample: $('#r-sample'),
  work: $('#r-work'), status: $('#r-status'), cmp: $('#r-cmp'),
  before: $('#r-before'), after: $('#r-after'),
  presets: $('#r-presets'), size: $('#r-size'), download: $('#r-download'), again: $('#r-again'),
};
const sliders = {}, outs = {};
KEYS.forEach((k) => { sliders[k] = $('#r-' + k); outs[k] = $('#r-' + k + 'Out'); });

const S = {
  w: 0, h: 0, src: null, pw: 0, ph: 0, name: 'photo',
  worker: null, ready: false, busy: false, queued: false, seq: 0, pid: 0, workerUrl: null,
  exporting: false, maxScale: 1,
};

const scaleSeg = SX.seg($('#r-scale'), () => { updateSize(); });
const fmtSeg = SX.seg($('#r-format'));

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
  if (!file || !/^image\//.test(file.type)) { toast('That file is not an image. Choose a JPG or PNG photo.', true); return; }
  toast('Reading photo…');
  await new Promise((r) => setTimeout(r, 30));
  let bmp;
  try { bmp = await decode(file); } catch (e) { toast("This photo couldn't be opened. Try a JPG or PNG.", true); return; }
  const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
  let f = 1;
  if (Math.max(bw, bh) > MAX_SIDE) f = MAX_SIDE / Math.max(bw, bh);
  if (bw * bh * f * f > MAX_PIXELS) f = Math.min(f, Math.sqrt(MAX_PIXELS / (bw * bh)));
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

  S.w = W; S.h = H; S.src = c; S.pw = pw; S.ph = ph;
  S.name = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'photo';

  for (const cv of [el.before, el.after]) { cv.width = pw; cv.height = ph; }
  el.before.getContext('2d').drawImage(pc, 0, 0);
  el.after.getContext('2d').drawImage(pc, 0, 0);
  el.cmp.style.setProperty('--ar', String(pw / ph));
  cmp.set(50);

  const p = (opts && opts.preset) || 'auto';
  applyPreset(p, true);
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
  SX.swap(el.intro, el.work);
}

/* ---------- live preview ---------- */
let statusTimer = 0;
function showStatus(on) {
  clearTimeout(statusTimer);
  if (on) statusTimer = setTimeout(() => el.status.classList.add('on'), 220);
  else el.status.classList.remove('on');
}
function readParams() {
  const p = { scale: +scaleSeg.value() || 1 };
  KEYS.forEach((k) => { p[k] = +sliders[k].value; });
  return p;
}
function requestPreview() {
  if (!S.ready) { S.queued = true; return; }
  if (S.busy) { S.queued = true; return; }
  runPreview();
}
function runPreview() {
  S.busy = true; S.queued = false; S.pid = ++S.seq;
  showStatus(true);
  const p = readParams(); p.scale = 1;   // the preview shows the tonal and detail work, not the larger size
  S.worker.postMessage({ type: 'run', id: S.pid, params: p });
}
function onMessage(e) {
  const m = e.data;
  if (m.type === 'ready') { S.ready = true; runPreview(); return; }
  if (m.type === 'error') { S.busy = false; showStatus(false); toast('Something went wrong while restoring. Try a smaller photo.', true); return; }
  if (m.type !== 'done') return;
  if (m.id === S.pid) {
    el.after.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data), m.w, m.h), 0, 0);
  }
  S.busy = false;
  if (S.queued) runPreview(); else showStatus(false);
}

/* ---------- controls ---------- */
function syncOutputs() { KEYS.forEach((k) => { outs[k].textContent = sliders[k].value; }); }
function setPressed(name) {
  $$('button', el.presets).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === name)));
}
function applyPreset(name, silent) {
  const v = PRESETS[name]; if (!v) return;
  KEYS.forEach((k) => { sliders[k].value = v[k]; SX.fillRange(sliders[k]); });
  syncOutputs(); setPressed(name);
  if (!silent) requestPreview();
}
KEYS.forEach((k) => {
  sliders[k].addEventListener('input', () => { outs[k].textContent = sliders[k].value; setPressed(null); requestPreview(); });
});
$$('button', el.presets).forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

function setScaleLimits() {
  S.maxScale = Math.sqrt(MAX_PIXELS / (S.w * S.h));
  scaleSeg.buttons.forEach((b) => {
    const off = +b.dataset.v > S.maxScale + 1e-6;
    if (off) { b.setAttribute('aria-disabled', 'true'); b.title = 'Over the ' + (MAX_PIXELS / 1e6) + ' megapixel limit for this photo'; }
    else { b.removeAttribute('aria-disabled'); b.removeAttribute('title'); }
  });
}
function updateSize() {
  const s = +scaleSeg.value() || 1;
  const ow = Math.round(S.w * s), oh = Math.round(S.h * s);
  el.size.textContent = ow + ' × ' + oh + ' px · ' + (ow * oh / 1e6).toFixed(1) + ' MP' + (S.maxScale < 4 ? '. Larger sizes are capped at ' + (MAX_PIXELS / 1e6) + ' MP.' : '');
}

const cmp = SX.compare(el.cmp);

/* ---------- download at full size ---------- */
el.download.addEventListener('click', async () => {
  if (S.exporting || !S.src) return;
  S.exporting = true;
  SX.busy(el.download, true, 'Preparing photo');
  let worker = null;
  try {
    const id = S.src.getContext('2d').getImageData(0, 0, S.w, S.h);
    const params = readParams();
    worker = makeWorker();
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') SX.busy(el.download, true, 'Processing ' + Math.round(m.p * 100) + '%');
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
    if (ok) SX.flash(el.download, 'Downloaded');
  } catch (err) {
    killWorker(worker);
    SX.busy(el.download, false);
    toast("Couldn't process the photo at this size. Try a smaller size setting.", true);
  } finally {
    S.exporting = false;
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
  await SX.swap(el.work, el.intro);
  killWorker(S.worker); S.worker = null; S.ready = false; S.busy = false; S.queued = false;
  S.src = null;
  showStatus(false);
});

syncOutputs();
})();
