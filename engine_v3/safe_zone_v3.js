/* safe_zone_v3.js — mandatory UI-safe layout for V3 (loaded after micro_text.js).
 *
 * UI-safe box on the 1080x1920 output (leaves room for Shorts/Reels buttons, header and title bar):
 *   SAFE_LEFT = 90, SAFE_RIGHT = 920, SAFE_TOP = 260, SAFE_BOTTOM = 1480
 *   = low-res 270x480 buffer: x 22.5..230, y 65..370  ->  R.SAFE = {x:23, y:65, w:207, h:305}
 *
 * - R.SAFE (used by micro-text, labels, banner, stamp, split layouts) is set to this box.
 * - The camera view defaults to the safe box, so world drawing is clipped to it.
 * - fitBoundsToSafeZone(contentWidth, contentHeight, requestedZoom) -> the largest zoom <= requestedZoom
 *   at which content of that world size fits inside the safe box (minus a margin).
 *   Camera.fitTo([x,y,w,h], {zoom, dur, ease}) and Camera.track([{t, fit:[x,y,w,h], zoom}]) use it.
 * - Every text box, R.box, R.tag, micro-text and R.node() is tracked each frame. Anything that
 *   extends outside the safe box is recorded; window.getSafeZoneReportV3() returns the violations
 *   (render_v3.py --preview-only FAILS QA if there are any).
 * - With ?qa=3 a faint magenta dashed border shows the safe box and offending boxes are outlined.
 *   Final renders never draw it.
 */
(function () {
  'use strict';
  const Retro = window.Retro, R = Retro.R, I = R._internal;
  const SCALE = R.SCALE;
  const SAFE_PX = { left: 90, right: 920, top: 260, bottom: 1480 };          // 1080x1920 output pixels
  const SZ = { l: SAFE_PX.left / SCALE, r: SAFE_PX.right / SCALE, t: SAFE_PX.top / SCALE, b: SAFE_PX.bottom / SCALE };
  window.SAFE_LEFT = SAFE_PX.left; window.SAFE_RIGHT = SAFE_PX.right;
  window.SAFE_TOP = SAFE_PX.top; window.SAFE_BOTTOM = SAFE_PX.bottom;

  Object.assign(R.SAFE, { x: Math.ceil(SZ.l), y: Math.ceil(SZ.t), w: Math.floor(SZ.r) - Math.ceil(SZ.l), h: Math.floor(SZ.b) - Math.ceil(SZ.t) });
  R.SAFE_V3 = R.SAFE;
  R.SAFE_PX = SAFE_PX;

  // ---------------------------------------------------------------- zoom fitting
  function fitBoundsToSafeZone(contentWidth, contentHeight, requestedZoom = Infinity, margin = 4) {
    const V = Camera.view, A = R.SAFE;
    const w = Math.min(A.x + A.w, V.x + V.w) - Math.max(A.x, V.x) - 2 * margin;
    const h = Math.min(A.y + A.h, V.y + V.h) - Math.max(A.y, V.y) - 2 * margin;
    const fit = Math.min(w / Math.max(1e-6, contentWidth), h / Math.max(1e-6, contentHeight));
    return Math.max(0.05, Math.min(requestedZoom, fit));
  }
  window.fitBoundsToSafeZone = fitBoundsToSafeZone;
  R.fitBoundsToSafeZone = fitBoundsToSafeZone;

  const origTrack = Camera.track.bind(Camera);
  Camera.track = function (keys) {
    return origTrack(keys.map(k => {
      if (!k.fit) return k;
      const [x, y, w, h] = k.fit;
      return Object.assign({}, k, { x: x + w / 2, y: y + h / 2, zoom: fitBoundsToSafeZone(w, h, k.zoom || Infinity, k.margin) });
    }));
  };
  Camera.fitTo = function (bbox, o = {}) {
    const [x, y, w, h] = bbox;
    Camera.focusOn(x + w / 2, y + h / 2, fitBoundsToSafeZone(w, h, o.zoom || Infinity, o.margin), o.dur === undefined ? 0.8 : o.dur, o.ease || 'inOut');
  };
  // In v3 the camera view defaults to the safe box (world drawing is clipped to it).
  Retro.hooks.reset.push(() => { const A = R.SAFE; Camera.setView(A.x, A.y, A.w, A.h); });

  // ---------------------------------------------------------------- bounding-box tracking
  let tracking = false;
  const frameBoxes = [];
  const report = new Map();
  const QA = new URLSearchParams(location.search).get('qa') === '3';

  function track(x, y, w, h, kind, label, screenSpace = false) {
    if (!tracking || !(w > 0) || !(h > 0)) return;
    if (!screenSpace && R.inWorld()) {
      const a = R.toScreen(x, y), b = R.toScreen(x + w, y + h);
      x = Math.min(a.x, b.x); y = Math.min(a.y, b.y); w = Math.abs(b.x - a.x); h = Math.abs(b.y - a.y);
    }
    const alpha = R._alphaHint != null ? R._alphaHint : I.ctx.globalAlpha;
    frameBoxes.push({ x, y, w, h, kind, label: String(label || '').slice(0, 40), alpha });
  }
  R.node = (x, y, w, h, label = 'node') => track(x, y, w, h, 'node', label);   // explicit "active node"
  R.trackUI = (rect, kind, label) => rect && track(rect.x, rect.y, rect.w, rect.h, kind, label, true);   // rect is in SCREEN coords

  // World-space text/boxes that would be CUT OFF by the camera view edge are not drawn at all
  // (zoomed arrays show only whole nodes); they are counted in the report as "hidden".
  const hidden = new Map();
  function screenRectOf(x, y, w, h) {
    const a = R.toScreen(x, y), b = R.toScreen(x + w, y + h);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  function insideView(r) {
    const V = Camera.view, e = 0.01;
    return r.x >= V.x - e && r.y >= V.y - e && r.x + r.w <= V.x + V.w + e && r.y + r.h <= V.y + V.h + e;
  }
  R.inView = (x, y, w, h) => insideView(R.inWorld() ? screenRectOf(x, y, w, h) : { x, y, w, h });
  function hide(kind, label) { const k = kind + ':' + label; hidden.set(k, (hidden.get(k) || 0) + 1); }

  const origText = R.text;
  R.text = function (str, x, y, o = {}) {
    if (R.inWorld() && String(str).length) {
      const s = o.scale || 1, w = R.textWidth(String(str).toUpperCase(), s), p = R.toScreen(x, y);
      let bx = p.x; if (o.align === 'center') bx = p.x - w / 2; else if (o.align === 'right') bx = p.x - w;
      const hgt = (String(str).split('\n').length - 1) * (o.lineHeight || 9) * s + 7 * s;
      if (!insideView({ x: bx, y: p.y, w, h: hgt })) { if (tracking) hide('text', str); return w; }
    }
    const res = origText.call(R, str, x, y, o);
    if (tracking && String(str).length) {
      const s = o.scale || 1, lines = String(str).split('\n'), w = res;   // glyph width is always in screen px
      const p = R.inWorld() ? R.toScreen(x, y) : { x, y };
      let bx = p.x;
      if (o.align === 'center') bx = p.x - w / 2; else if (o.align === 'right') bx = p.x - w;
      // {data:true} marks values (array items, counts) — exempt from the word / static-text rules
      track(bx, p.y, w, (lines.length - 1) * (o.lineHeight || 9) * s + 7 * s, o.data ? 'data' : 'text', str, true);
    }
    return res;
  };
  const origBox = R.box;
  R.box = function (x, y, w, h, o = {}) {
    if (R.inWorld() && !insideView(screenRectOf(x, y, w, h))) { if (tracking) hide('box', o.label || ''); return; }
    origBox.call(R, x, y, w, h, o); track(x, y, w, h, 'box', o.label || '');
  };
  const origTag = R.tag;   // R.tag always returns SCREEN coordinates
  R.tag = function (str, x, y, c, o) { const r = origTag.call(R, str, x, y, c, o); if (r) track(r.x, r.y, r.w, r.h, 'tag', str, true); return r; };

  // ---- text rules (v3 reactive text): <= MAX_WORDS words per text element; no BRIGHT text (alpha >= 0.6)
  //      may sit on screen unchanged for more than STATIC_S seconds (dim it or clear it). Digits = data, exempt.
  let MAX_WORDS = 4, STATIC_S = 5;                                  // timeline.text_rules can override (read at boot)
  Retro.hooks.reset.push(() => {
    const T0 = (window.EPISODE_TIMELINE && window.EPISODE_TIMELINE.text_rules) || {};
    MAX_WORDS = T0.max_words || 4; STATIC_S = T0.static_seconds || 5;
  });
  const streak = new Map(), lastPos = new Map();
  const wordCount = (str) => String(str).trim().split(/\s+/).filter(w => /[A-Z0-9]/i.test(w)).length;
  function flag(kind, label, extra) {
    const key = kind + ':' + label;
    const r = report.get(key) || { kind, label, firstFrame: R.frame, lastFrame: R.frame, frames: 0, maxOverflowPx: 0, at: { t: +(R.frame / R.FPS).toFixed(2) }, ...extra };
    r.lastFrame = R.frame; r.frames++;
    report.set(key, r);
  }
  function textRules() {
    const seen = new Set();
    for (const b of frameBoxes) {
      if (b.kind !== 'text' || !b.label || b.alpha < 0.6) continue;
      if (wordCount(b.label) > MAX_WORDS) flag('words', b.label, { words: wordCount(b.label), rule: `<= ${MAX_WORDS} words` });
      if (seen.has(b.label)) continue;
      seen.add(b.label);
      // a text element that moves (e.g. a pointer tag re-popping on each hop) is reacting, so its clock restarts
      const prev = lastPos.get(b.label);
      const moved = prev && (Math.abs(prev.x - b.x) > 2 || Math.abs(prev.y - b.y) > 2);
      lastPos.set(b.label, { x: b.x, y: b.y });
      const n = moved ? 1 : (streak.get(b.label) || 0) + 1;
      streak.set(b.label, n);
      if (n === Math.round(STATIC_S * R.FPS) + 1) flag('static', b.label, { rule: `bright for > ${STATIC_S}s — dim or clear it` });
    }
    for (const k of [...streak.keys()]) if (!seen.has(k)) { streak.delete(k); lastPos.delete(k); }
  }

  function evaluate() {
    const eps = 0.01;
    textRules();
    for (const b of frameBoxes) {
      const over = Math.max(SZ.l - b.x, b.x + b.w - SZ.r, SZ.t - b.y, b.y + b.h - SZ.b);
      if (over > eps) {
        b.bad = true;
        const key = b.kind + ':' + b.label;
        const r = report.get(key) || { kind: b.kind, label: b.label, firstFrame: R.frame, lastFrame: R.frame, frames: 0, maxOverflowPx: 0, at: null };
        r.lastFrame = R.frame; r.frames++;
        if (over * SCALE > r.maxOverflowPx) {
          r.maxOverflowPx = Math.round(over * SCALE);
          r.at = { t: +(R.frame / R.FPS).toFixed(2), x: Math.round(b.x * SCALE), y: Math.round(b.y * SCALE), w: Math.round(b.w * SCALE), h: Math.round(b.h * SCALE) };
        }
        report.set(key, r);
      }
    }
  }
  function qaOverlay() {
    const ctx = I.ctx, c = '#FF2BD6';
    ctx.save(); ctx.globalAlpha = 0.6;
    R.screen(() => {
      const x0 = SZ.l, x1 = SZ.r, y0 = SZ.t, y1 = SZ.b;
      R.dashed(x0, y0, x1, y0, c, 3, 3); R.dashed(x0, y1, x1, y1, c, 3, 3);
      R.dashed(x0, y0, x0, y1, c, 3, 3); R.dashed(x1, y0, x1, y1, c, 3, 3);
    });
    ctx.globalAlpha = 1;
    for (const b of frameBoxes) if (b.bad) {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, Math.round(b.w) + 2, 1);
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y + b.h), Math.round(b.w) + 2, 1);
      ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 1, Math.round(b.h) + 2);
      ctx.fillRect(Math.round(b.x + b.w), Math.round(b.y) - 1, 1, Math.round(b.h) + 2);
    }
    ctx.restore();
    origText.call(R, `QA ${R.t.toFixed(2)}S ${R.currentBeat() || ''}`, 2, 2, { color: c, shadow: false });
  }

  Retro.hooks.afterUpdate.push(() => { frameBoxes.length = 0; tracking = true; });
  Retro.hooks.afterDraw.push(() => { evaluate(); tracking = false; if (QA) qaOverlay(); });
  Retro.hooks.reset.push(() => { report.clear(); hidden.clear(); streak.clear(); lastPos.clear(); frameBoxes.length = 0; });

  window.getSafeZoneReportV3 = () => ({
    safe_px: SAFE_PX,
    violations: [...report.values()].sort((a, b) => b.maxOverflowPx - a.maxOverflowPx),
    auto_hidden: [...hidden.entries()].map(([k, n]) => ({ element: k, frames: n }))
  });
})();
