/* Shared shell: router with view transitions, toast, downloads, compare slider,
   segmented controls, range fill, drag/drop/paste routing. */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const EASE = 'cubic-bezier(.22,1,.36,1)';
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SX = (window.SX = { tools: {}, route: 'home', clamp, $, $$, reduce, EASE });

  /* ---------- toast ---------- */
  let toastTimer = 0, toastHide = 0;
  SX.toast = function (msg, isErr) {
    const el = $('#toast');
    clearTimeout(toastTimer); clearTimeout(toastHide);
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      toastHide = setTimeout(() => { el.hidden = true; }, 260);
    }, isErr ? 6000 : 3200);
  };
  SX.hideToast = function () { const el = $('#toast'); el.classList.remove('show'); el.hidden = true; };

  /* ---------- show one element, hide another, with a short transition ---------- */
  SX.swap = async function (a, b) {
    if (a && !a.hidden && !reduce()) {
      const out = a.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 140, easing: EASE, fill: 'forwards' });
      await out.finished.catch(() => {});
      out.cancel();
    }
    if (a) a.hidden = true;
    b.hidden = false;
    if (!reduce()) b.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
  };

  /* ---------- button helpers ---------- */
  SX.busy = function (btn, on, label) {
    const span = $('span', btn);
    if (on) {
      btn.setAttribute('aria-busy', 'true');
      if (label != null && span) { if (btn._label == null) btn._label = span.textContent; span.textContent = label; }
    } else {
      btn.removeAttribute('aria-busy');
      if (btn._label != null && span) { span.textContent = btn._label; btn._label = null; }
    }
  };
  SX.flash = function (btn, text, ms) {
    const span = $('span', btn), use = $('use', btn);
    const oldText = span.textContent, oldIcon = use && use.getAttribute('href');
    btn.dataset.state = 'done';
    span.textContent = text;
    if (use) use.setAttribute('href', '#i-check');
    setTimeout(() => {
      delete btn.dataset.state;
      span.textContent = oldText;
      if (use && oldIcon) use.setAttribute('href', oldIcon);
    }, ms || 1600);
  };


  /* ---------- top progress bar ---------- */
  const bar = $('#progress');
  SX.progress = (() => {
    let v = 0, timer = 0, hideT = 0, active = false;
    const paint = () => { if (bar) bar.style.transform = 'scaleX(' + v + ')'; };
    const api = {
      start() {
        clearTimeout(hideT); clearInterval(timer);
        active = true; v = 0.08;
        if (bar) { bar.classList.add('on'); }
        paint();
        timer = setInterval(() => { v += (0.86 - v) * 0.07; paint(); }, 120);
      },
      set(p) {
        if (!active) api.start();
        clearInterval(timer);
        v = Math.max(v, Math.min(0.97, p)); paint();
      },
      done() {
        clearInterval(timer);
        if (!active) return;
        active = false; v = 1; paint();
        hideT = setTimeout(() => {
          if (bar) bar.classList.remove('on');
          hideT = setTimeout(() => { v = 0; paint(); }, 300);
        }, 220);
      },
    };
    return api;
  })();

  /* ---------- drop zone while a file is being read ---------- */
  SX.dropBusy = function (drop, on) {
    clearTimeout(drop._busyT);
    const h = $('h2', drop);
    if (on) {
      drop.setAttribute('aria-busy', 'true');
      // only show the loading state if reading takes a moment, so quick opens do not flicker
      drop._busyT = setTimeout(() => {
        drop.classList.add('is-loading');
        if (h) { if (drop._h == null) drop._h = h.textContent; h.textContent = 'Reading your photo'; }
      }, 140);
    } else {
      drop.removeAttribute('aria-busy');
      drop.classList.remove('is-loading');
      if (h && drop._h != null) { h.textContent = drop._h; drop._h = null; }
    }
  };

  /* ---------- three-step indicator on the tool pages ---------- */
  SX.steps = function (ol, n) {
    if (!ol) return;
    $$('li', ol).forEach((li, i) => {
      li.classList.toggle('done', i < n - 1);
      if (i === n - 1) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  };

  /* ---------- saving a file ---------- */
  // Inside Claude the page asks the host to save; anywhere else it uses a normal download link.
  let hostDownloads = null;
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude.use('downloads').then((c) => { hostDownloads = c || null; }).catch(() => {});
    }
  } catch (_) {}
  function linkDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  SX.saveBlob = async function (blob, filename) {
    if (hostDownloads) {
      try {
        await hostDownloads.save({ filename, data: blob });
        SX.toast('Saved ' + filename);
        return true;
      } catch (err) {
        if (err && err.code === 'declined') return false;
        if (!(err && err.code === 'unavailable')) { SX.toast("Couldn't save the file here. Try Copy image instead.", true); return false; }
      }
    }
    linkDownload(blob, filename);
    SX.toast('Downloading ' + filename);
    return true;
  };

  /* ---------- range fill ---------- */
  function fillRange(r) {
    const min = +r.min || 0, max = +r.max || 100;
    r.style.setProperty('--p', ((r.value - min) / (max - min)) * 100 + '%');
  }
  SX.fillRange = fillRange;
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('input[type=range]')) fillRange(e.target); }, true);

  /* ---------- segmented control with a sliding thumb ---------- */
  SX.seg = function (el, onChange) {
    const btns = $$('button', el);
    el.style.setProperty('--n', btns.length);
    const set = (i) => {
      btns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      el.style.setProperty('--i', i);
    };
    set(Math.max(0, btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true')));
    btns.forEach((b, i) => b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      set(i);
      if (onChange) onChange(b.dataset.v, i);
    }));
    return {
      set(v) { const i = btns.findIndex((b) => b.dataset.v === String(v)); if (i >= 0) set(i); },
      value() { const b = btns.find((x) => x.getAttribute('aria-pressed') === 'true'); return b ? b.dataset.v : null; },
      buttons: btns,
    };
  };

  /* ---------- before / after compare ---------- */
  SX.compare = function (root) {
    const handle = $('.cmp-handle', root);
    let pos = 50, dragging = false, raf = 0;
    const set = (v) => {
      pos = clamp(v, 0, 100);
      root.style.setProperty('--pos', pos + '%');
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
    };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    const fromEvent = (e) => { const r = root.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
    root.addEventListener('pointerdown', (e) => {
      if (root.classList.contains('marking')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      stop(); dragging = true; root.classList.add('dragging');
      try { root.setPointerCapture(e.pointerId); } catch (_) {}
      fromEvent(e);
    });
    root.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    const end = () => { dragging = false; root.classList.remove('dragging'); };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      let v = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = pos - step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = pos + step;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 100;
      if (v !== null) { e.preventDefault(); stop(); set(v); }
    });
    function animateTo(target, ms) {
      stop();
      if (reduce()) { set(target); return; }
      const from = pos, t0 = performance.now();
      const tick = (now) => {
        const t = clamp((now - t0) / ms, 0, 1);
        set(from + (target - from) * (1 - Math.pow(1 - t, 3)));
        raf = t < 1 ? requestAnimationFrame(tick) : 0;
      };
      raf = requestAnimationFrame(tick);
    }
    set(50);
    return { set, animateTo };
  };

  /* ---------- router ---------- */
  const NAMES = ['home', 'signature', 'restore'];
  const views = {};
  NAMES.forEach((n) => { views[n] = $('#view-' + n); });
  const routeFromHash = () => { const h = location.hash.replace('#', ''); return views[h] ? h : 'home'; };

  async function show(name, first) {
    if (!first && name === SX.route) return;
    const prev = views[SX.route], next = views[name];
    SX.route = name;
    $$('[data-nav]').forEach((a) => {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = next.dataset.title || document.title;
    document.documentElement.dataset.route = name;
    SX.hideToast();
    if (first) {
      NAMES.forEach((n) => { views[n].hidden = n !== name; });
      return;
    }
    SX.progress.start();
    if (prev && !prev.hidden && !reduce()) {
      const out = prev.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 140, easing: EASE, fill: 'forwards' });
      await out.finished.catch(() => {});
      out.cancel();
    }
    if (SX.route !== name) { SX.progress.done(); return; }   // the route changed again while fading out
    NAMES.forEach((n) => { views[n].hidden = n !== name; });
    window.scrollTo(0, 0);
    if (!reduce()) next.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
    const h = $('h1', next);
    if (h) h.focus({ preventScroll: true });
    watchReveals(next);
    SX.progress.done();
  }
  window.addEventListener('hashchange', () => show(routeFromHash(), false));

  /* ---------- files: drag, drop and paste go to the tool on screen ---------- */
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const tool = SX.tools[SX.route];
    if (tool) tool.over(true);
  }));
  document.addEventListener('dragleave', (e) => {
    const tool = SX.tools[SX.route];
    if (tool && !e.relatedTarget) tool.over(false);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const tool = SX.tools[SX.route];
    if (!tool) return;
    tool.over(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) tool.load(f);
  });
  document.addEventListener('paste', (e) => {
    const tool = SX.tools[SX.route];
    if (!tool) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) { tool.load(it.getAsFile()); e.preventDefault(); return; }
    }
  });

  /* ---------- sample images ---------- */
  SX.fetchFile = async function (url, name, type) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    return new File([blob], name, { type: type || blob.type || 'image/jpeg' });
  };

  /* ---------- scroll reveal ---------- */
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) : null;
  function watchReveals(scope) {
    $$('.sr:not(.in)', scope || document).forEach((n) => { if (io) io.observe(n); else n.classList.add('in'); });
  }

  /* ---------- boot ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $$('input[type=range]').forEach(fillRange);
  show(routeFromHash(), true);

  const demo = SX.compare($('#demo-cmp'));
  SX.compare($('#card-cmp'));
  demo.set(96);

  // The splash stays for a short, fixed beat (the stroke needs about a second to draw),
  // and for longer only if fonts or the page are still loading. A CSS rule and a timer
  // in the page head also clear it, so a script error can never leave it on screen.
  const root = document.documentElement;
  const boot = $('#boot');
  const MIN_SPLASH = 1400, MAX_SPLASH = 4000;
  const t0 = performance.now();
  let started = false;
  function ready() {
    if (started) return;
    started = true;
    root.classList.add('is-ready');
    watchReveals(document);
    if (boot) {
      boot.classList.add('out');
      setTimeout(() => { if (boot.parentNode) boot.remove(); }, reduce() ? 0 : 700);
    }
    // one explanatory sweep once the hero has settled
    setTimeout(() => demo.animateTo(50, 1100), reduce() ? 0 : 1100);
  }
  if (!boot || reduce()) {
    ready();
  } else {
    const loaded = new Promise((res) => { if (document.readyState === 'complete') res(); else window.addEventListener('load', res, { once: true }); });
    const fonts = document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve();
    Promise.all([loaded, fonts]).then(() => {
      const wait = Math.max(0, MIN_SPLASH - (performance.now() - t0));
      setTimeout(ready, wait);
    });
    setTimeout(ready, MAX_SPLASH);
  }
})();
