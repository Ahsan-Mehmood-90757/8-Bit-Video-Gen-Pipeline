/* micro_text.js — V3 Visual-First layer: Impact Micro-Text, Hook Banner, Payoff Stamp, beat clock.
 * Load after engine/retro_engine.js + engine/camera_ui.js + engine_v3/audio_events_v3.js.
 *
 * With no captions in v3, the whole 900x1420 safe rectangle is available, so R.SAFE grows to
 * {x:22, y:55, w:226, h:355} (low-res px). Every micro-text box is clamped inside it.
 *
 *   R.micro(text, x, y, {t0, dur, style, color, size, at:[dx,dy], pointer, anim, priority})
 *       2–5 word pixel badge anchored to a moving part / state change (world coords inside R.world).
 *       style: 'badge' (default) | 'warn' | 'tag' | 'stamp' | 'formula' | 'ok'
 *       anim:  'pop' | 'shake' | 'flash' (combine: 'pop shake') — defaults depend on style
 *       Visible from t0 for dur seconds, pops in, fades out; auto-placed above the anchor, pushed
 *       away from other micro-text / labels / R.reserve() rects, and clamped inside the safe zone.
 *   R.hookBanner(text, {t0=0, dur=3, sub, color, sfx='banner'})   slam-in banner for the first 3 s
 *   R.payoffStamp(text, {t0, dur, color, sub, y, sfx='stamp'})      end-card stamp ("FIXED RAM.\nO(1) FLOW.")
 *   R.formula(text, x, y, {t0, dur})                               typewriter formula flash ("HEAD=(HEAD+1)%8")
 *   R.pulse(kind, {note, accent, pan})                             rhythmic accent at this frame (kick/bass/hat/snare)
 *   R.synth(voice, {freq, duty, gain, noise, cutoff, res, wave, pan})   continuous voice with filter modulation
 *   R.tempo -> {bpm, spb, start};  R.onBeat(div=1) -> true on the frame of each beat (same frame math as synth_v3.py)
 *   R.beatNum(div=1) -> current beat index
 */
(function () {
  'use strict';
  const Retro = window.Retro, R = Retro.R, PAL = R.PAL, I = R._internal;
  const FPS = R.FPS, W = R.W, H = R.H;
  const rnd = Math.round;

  // ---- v3 safe zone is defined in engine_v3/safe_zone_v3.js (SAFE_LEFT/RIGHT/TOP/BOTTOM)
  R.VERSION = 3;
  const SCX = () => R.SAFE.x + R.SAFE.w / 2;   // safe-zone centre (asymmetric: wider right margin)

  // ---- audio helpers
  R.pulse = (kind, o = {}) => window.logBeatPulseV3(R.frame, Object.assign({ kind }, o));
  R.synth = (voice, o = {}) => window.logSynthStateV3(R.frame, Object.assign({ voice }, o));

  // ---- tempo / beat clock (frame-quantized exactly like synth_v3.py: frame = ceil(T*fps - 1e-9))
  R.tempo = { bpm: 120, spb: 0.5, start: 0 };
  function tempoFromTimeline() {
    const T = window.EPISODE_TIMELINE || {};
    const bpm = (T.groove && T.groove.bpm) || T.bpm || 120;
    R.tempo = { bpm, spb: 60 / bpm, start: (T.groove && T.groove.start) || 0 };
  }
  const beatFrame = (k, step) => Math.ceil((R.tempo.start + k * step) * FPS - 1e-9);
  R.onBeat = function (div = 1) {
    const step = R.tempo.spb / div, tt = R.frame / FPS - R.tempo.start;
    if (tt < -1e-9) return false;
    const k = Math.floor(tt / step + 1e-9);
    for (const kk of [k, k + 1]) if (kk >= 0 && beatFrame(kk, step) === R.frame) return true;
    return false;
  };
  R.beatNum = (div = 1) => Math.max(-1, Math.floor((R.t - R.tempo.start) / (R.tempo.spb / div) + 1e-9));

  // ================================================================== Compact digits (3x5 font)
  // For dense numeric grids: at scale 2 a digit is 6x10 low-res px (24x40 on 1080x1920) with a 2 px gap,
  // so two-digit values fit in narrow cells with clear separation. Supports 0-9 . , - % : < > = and space.
  const D35 = {
    '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
    '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
    '.': [0, 0, 0, 0, 2], ',': [0, 0, 0, 2, 4], '-': [0, 0, 7, 0, 0], '%': [5, 1, 2, 4, 5], ':': [0, 2, 0, 2, 0],
    '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4], '=': [0, 7, 0, 7, 0], ' ': [0, 0, 0, 0, 0]
  };
  R.digitsWidth = (str, scale = 2) => { const n = String(str).length; return n ? (n * 4 - 1) * scale : 0; };
  R.digits = function (str, x, y, o = {}) {
    const s = o.scale || 2, txt = String(str), w = R.digitsWidth(txt, s), ctx = I.ctx;
    let p = R.inWorld() ? R.toScreen(x, y) : { x, y };
    let bx = p.x; if (o.align === 'center') bx = p.x - w / 2; else if (o.align === 'right') bx = p.x - w;
    bx = rnd(bx); const by = rnd(p.y);
    if (R.inWorld() && !R.inView(bx, by, w, 5 * s)) return w;           // never draw cut-off digits
    const pass = (c, dx, dy) => {
      ctx.fillStyle = c;
      let cx = bx + dx;
      for (const ch of txt) {
        const g = D35[ch] || D35[' '];
        for (let r = 0; r < 5; r++) for (let col = 0; col < 3; col++) if ((g[r] >> (2 - col)) & 1) ctx.fillRect(cx + col * s, by + dy + r * s, s, s);
        cx += 4 * s;
      }
    };
    if (o.shadow) pass(o.shadow === true ? PAL.black : o.shadow, 1, 1);
    pass(o.color || PAL.white, 0, 0);
    if (R.trackUI) R.trackUI({ x: bx, y: by, w, h: 5 * s }, 'text', txt);
    return w;
  };

  // ================================================================== Impact micro-text
  const queue = [];
  // micro-text also avoids every R.reserve() rect (banner, stamp, HUD panels) — mirror them here
  const microRes = [];
  { const origReserve = R.reserve;
    R.reserve = function (x, y, w, h) {
      if (x && typeof x === 'object') ({ x, y, w, h } = x);
      microRes.push({ x, y, w, h });
      return origReserve(x, y, w, h);
    }; }
  const STYLE = {
    badge:   { fill: () => PAL.gold, text: () => PAL.bg, border: () => PAL.black, anim: 'pop' },
    ok:      { fill: () => PAL.emerald, text: () => PAL.bg, border: () => PAL.black, anim: 'pop' },
    warn:    { fill: () => PAL.coral, text: () => PAL.white, border: () => PAL.white, anim: 'pop shake flash' },
    tag:     { fill: () => PAL.bg, text: null, border: null, anim: 'pop' },
    stamp:   { fill: () => PAL.bg, text: null, border: null, anim: 'pop shake', size: 2, double: true },
    formula: { fill: () => PAL.black, text: () => PAL.emerald, border: () => PAL.dim, anim: 'pop', type: true }
  };

  R.micro = function (text, x, y, o = {}) {
    const t0 = o.t0 === undefined ? -1e9 : o.t0, dur = o.dur === undefined ? 1e9 : o.dur;
    const age = R.t - t0;
    if (age < 0 || age > dur) return;
    const p = R.inWorld() ? R.toScreen(x, y) : { x, y };
    const st = STYLE[o.style || 'badge'] || STYLE.badge;
    queue.push({ text: String(text).toUpperCase(), ax: p.x, ay: p.y, o, st, age, left: dur - age, n: queue.length,
      size: o.size || st.size || 1, color: o.color || (st === STYLE.tag || st === STYLE.stamp ? PAL.gold : null) });
  };
  R.formula = (text, x, y, o = {}) => R.micro(text, x, y, Object.assign({ style: 'formula', pointer: false }, o));

  function boxFor(m) {
    const s = m.size, tw = R.textWidth(m.text, s);
    return { w: tw + 8 * s + (m.st.double ? 4 : 0), h: 7 * s + 6 + (s > 1 ? 2 : 0) + (m.st.double ? 4 : 0) };
  }
  const overlap = (a, b, g = 2) => a.x < b.x + b.w + g && a.x + a.w + g > b.x && a.y < b.y + b.h + g && a.y + a.h + g > b.y;

  function flushMicro() {
    if (!queue.length) { microRes.length = 0; return; }
    const A = R.SAFE;
    const list = queue.splice(0).sort((a, b) => ((b.o.priority || 0) - (a.o.priority || 0)) || (a.n - b.n));
    const placed = microRes.splice(0);
    for (const m of list) {
      const { w, h } = boxFor(m);
      // shrink to fit the safe width if needed
      if (w > A.w && m.size > 1) { m.size--; }
      const bw = boxFor(m).w, bh = boxFor(m).h;
      let x, y;
      if (m.o.at) { x = m.ax + m.o.at[0] - bw / 2; y = m.ay + m.o.at[1] - bh / 2; }
      else { x = m.ax - bw / 2; y = m.ay - bh - 9; }
      x = R.clamp(rnd(x), A.x, A.x + A.w - bw); y = R.clamp(rnd(y), A.y, A.y + A.h - bh);
      const r = { x, y, w: bw, h: bh };
      let guard = 0, dir = -1;
      while (guard++ < 30) {
        const hit = placed.find(q => overlap(r, q));
        if (!hit) break;
        r.y = dir < 0 ? hit.y - bh - 3 : hit.y + hit.h + 3;
        if (r.y < A.y) { dir = 1; r.y = R.clamp(y, A.y, A.y + A.h - bh); }
        if (r.y + bh > A.y + A.h) { r.y = A.y + A.h - bh; break; }
      }
      placed.push(r);
      drawMicro(m, r);
    }
  }

  function drawMicro(m, r) {
    const st = m.st, s = m.size, anim = m.o.anim || st.anim, ctx = I.ctx;
    const accent = m.color || (st.fill ? st.fill() : PAL.gold);
    const kPop = R.clamp(m.age / 0.16, 0, 1);
    let dx = 0, dy = 0;
    if (anim.includes('pop')) dy = rnd((1 - R.ease.outBack(kPop)) * 6);
    if (anim.includes('shake') && m.age < 0.35) dx = rnd(Math.sin(R.frame * 2.7) * 2 * (1 - m.age / 0.35));
    const flashOn = anim.includes('flash') ? (m.age < 0.6 && Math.floor(m.age * 60 / 4) % 2 === 0) : false;
    const white = R.frame !== undefined && m.age < 2 / 60;   // 2-frame white impact flash
    const fadeK = m.left < 0.2 ? R.clamp(m.left / 0.2, 0, 1) : 1;
    ctx.save();
    ctx.globalAlpha = fadeK;
    const A = R.SAFE;
    const x = R.clamp(r.x + dx, A.x, A.x + A.w - r.w), y = R.clamp(r.y + dy, A.y, A.y + A.h - r.h);   // animations never leave the safe box
    R.screen(() => {
      // pointer to the target (dark-outlined so it reads on any background)
      const inside = m.ax >= r.x && m.ax <= r.x + r.w && m.ay >= r.y && m.ay <= r.y + r.h;
      if (m.o.pointer !== false && !inside && st !== STYLE.formula) {
        const ex = R.clamp(m.ax, x + 3, x + r.w - 3), ey = m.ay < y ? y : y + r.h;
        I.lineScreen(ex, ey, m.ax, m.ay, PAL.black, 3);
        I.lineScreen(ex, ey, m.ax, m.ay, accent, 1);
        R.rect(m.ax - 2, m.ay - 2, 5, 5, PAL.black); R.rect(m.ax - 1, m.ay - 1, 3, 3, accent);
      }
      const fill = white ? PAL.white : flashOn ? PAL.white : (st.fill ? (st === STYLE.badge || st === STYLE.ok ? accent : st.fill()) : PAL.bg);
      const border = st.border ? st.border() : accent;
      R.rect(x + 2, y + 2, r.w, r.h, PAL.black);                  // hard drop shadow
      R.rect(x, y, r.w, r.h, border);
      R.rect(x + 1, y + 1, r.w - 2, r.h - 2, fill);
      if (st.double) { R.rect(x + 2, y + 2, r.w - 4, r.h - 4, accent); R.rect(x + 3, y + 3, r.w - 6, r.h - 6, fill); }
      let txt = m.text;
      if (st.type) {
        const n = Math.floor(R.clamp(m.age * 28, 0, txt.length));
        txt = txt.slice(0, n) + (Math.floor(R.t * 3) % 2 === 0 || n < m.text.length ? '█' : ' ');
      }
      const tcol = flashOn || white ? PAL.coral : (st.text ? st.text() : accent);
      const off = st.double ? 2 : 0;
      R.text(txt, x + 4 * s + off, y + 3 + off + (s > 1 ? 1 : 0), { color: tcol, scale: s, shadow: false });
    });
    ctx.restore();
  }

  // ================================================================== Hook banner (first ~3 s)
  R.hookBanner = function (text, o = {}) {
    const t0 = o.t0 || 0, dur = o.dur === undefined ? 3 : o.dur, age = R.t - t0;
    if (o.sfx !== false && R.crossed(t0)) R.sfx(o.sfx || 'banner');
    if (age < 0 || age > dur) return;
    const A = R.SAFE, color = o.color || PAL.gold;
    let s = 2;
    const lines = String(text).toUpperCase().split('\n');
    while (s > 1 && Math.max(...lines.map(l => R.textWidth(l, s))) > A.w - 16) s--;
    const th = lines.length * 9 * s, sub = o.sub ? String(o.sub).toUpperCase() : null;
    const h = th + 8 + (sub ? 11 : 0);
    const slam = R.clamp(age / 0.18, 0, 1);
    const fadeK = dur - age < 0.25 ? (dur - age) / 0.25 : 1;
    const y0 = o.y === undefined ? A.y + 1 : o.y;
    const reveal = Math.max(1, rnd(h * R.clamp(R.ease.outBack(slam), 0, 1)));      // slams down from the safe top edge
    const shake = age < 0.4 ? rnd(Math.sin(R.frame * 3.1) * 2 * (1 - age / 0.4)) : 0;
    const bw = A.w - 6, bx = A.x + 2 + shake;                                       // 2px headroom each side for the shake
    const ctx = I.ctx;
    ctx.save(); ctx.globalAlpha = fadeK;
    ctx.beginPath(); ctx.rect(A.x, y0, A.w, reveal + 3); ctx.clip();
    R.screen(() => {
      R.rect(bx + 2, y0 + 2, bw, h, PAL.black);
      R.rect(bx, y0, bw, h, age < 2 / 60 ? PAL.white : color);
      R.rect(bx + 2, y0 + 2, bw - 4, h - 4, PAL.bg);
      lines.forEach((l, i) => R.text(l, SCX() + shake, y0 + 5 + i * 9 * s, { color, scale: s, align: 'center' }));
      if (sub) R.text(sub, SCX() + shake, y0 + 6 + th, { color: PAL.text, align: 'center' });
    });
    ctx.restore();
    R.reserve(A.x, y0, A.w, h + 2);
  };

  // ================================================================== Payoff stamp (final ~3 s)
  R.payoffStamp = function (text, o = {}) {
    const t0 = o.t0 || 0, dur = o.dur === undefined ? 1e9 : o.dur, age = R.t - t0;
    if (R.crossed(t0) && o.sfx !== false) { R.sfx(o.sfx || 'stamp'); R.shake(4, 12); }
    if (age < 0 || age > dur) return;
    const A = R.SAFE, color = o.color || PAL.emerald;
    const lines = String(text).toUpperCase().split('\n');
    let s = o.size || 3;
    while (s > 1 && Math.max(...lines.map(l => R.textWidth(l, s))) > A.w - 18) s--;
    const big = age < 0.1 && s < 4 && Math.max(...lines.map(l => R.textWidth(l, s + 1))) <= A.w - 18 ? s + 1 : s;  // slam from one size up
    const tw = Math.max(...lines.map(l => R.textWidth(l, big)));
    const sub = o.sub ? String(o.sub).toUpperCase() : null;
    const w = tw + 16, h = lines.length * 9 * big + 12 + (sub ? 12 : 0);
    const cy = o.y === undefined ? A.y + A.h / 2 : o.y;
    const shk = age < 0.3 ? rnd(Math.sin(R.frame * 2.9) * 3 * (1 - age / 0.3)) : 0;
    const x = R.clamp(rnd(SCX() - w / 2) + shk, A.x, A.x + A.w - w - 3), y = R.clamp(rnd(cy - h / 2), A.y, A.y + A.h - h - 3);
    if (R.crossed(t0)) R.burst(SCX(), cy, 34, [color, PAL.gold, PAL.white], 2.4);
    R.screen(() => {
      R.rect(x + 3, y + 3, w, h, PAL.black);
      R.rect(x, y, w, h, age < 2 / 60 ? PAL.white : color);
      R.rect(x + 2, y + 2, w - 4, h - 4, PAL.bg);
      R.rect(x + 4, y + 4, w - 8, h - 8, color);
      R.rect(x + 5, y + 5, w - 10, h - 10, PAL.bg);
      lines.forEach((l, i) => R.text(l, x + w / 2, y + 7 + i * 9 * big, { color, scale: big, align: 'center' }));
      if (sub) R.text(sub, x + w / 2, y + h - 12, { color: PAL.text, align: 'center' });
    });
    R.reserve(x, y, w, h);
  };

  Retro.hooks.reset.push(() => { queue.length = 0; microRes.length = 0; tempoFromTimeline(); });
  Retro.hooks.afterDraw.push(flushMicro);
})();
