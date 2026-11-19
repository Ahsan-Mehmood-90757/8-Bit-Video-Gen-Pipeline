/* retro_audio.js — procedural 8-bit SFX for the browser preview + event logger.
 *
 * The SAME synthesis algorithm is implemented in pipeline/synth_sfx.py, and both
 * read engine/sfx_presets.js, so what you hear in the live preview is what the
 * final render gets (the final render never uses the browser's audio output —
 * it only uses the logged events).
 *
 *   window.logSfx(eventType, frameNumber, pitch, opts)  -> logs (and plays in preview)
 *   window.getSfxEvents()                               -> array for sfx_events.json
 *   window.logSynthState(frame, freqHz, duty, gain, noise, {voice, wave, pan})
 *                                                       -> continuous physics-coupled voices (motors, hums, flows)
 *   window.getSynthStates()                             -> {voice: {wave, pan, frames:[[f,hz,duty,gain,noise]]}}
 *   RetroAudio.synth(type, pitch, sampleRate)           -> Float32Array (mono)
 */
(function () {
  'use strict';

  // Engine presets + optional channel overrides (channels/<slug>/sfx_presets.js -> window.CHANNEL_SFX_PRESETS)
  const getPresets = () => Object.assign({}, window.SFX_PRESETS || {}, window.CHANNEL_SFX_PRESETS || {});
  const FPS_DEFAULT = 60;

  // ---- NES-style 15-bit LFSR noise (deterministic, identical in Python) ----
  function makeLfsr() {
    let reg = 1;
    return function step() {
      const fb = (reg & 1) ^ ((reg >> 1) & 1);
      reg = (reg >> 1) | (fb << 14);
      return (reg & 1) ? -1 : 1;
    };
  }

  function levelAt(L, t) {
    const a = L.a || 0, d = L.d || 0, s = (L.s === undefined ? 1 : L.s);
    if (t < a) return a > 0 ? t / a : 1;
    if (t < a + d) return d > 0 ? 1 - (1 - s) * (t - a) / d : s;
    return s;
  }

  function synthLayer(L, pitch, sr) {
    const delay = L.delay || 0, dur = Math.max(L.dur || 0.05, 1e-4), r = L.r || 0;
    const n = Math.ceil((delay + dur + r) * sr) + 1;
    const out = new Float32Array(n);
    const relLevel = levelAt(L, dur);
    const f0 = L.freq || 440, f1 = L.freqEnd || f0;
    const duty = L.duty === undefined ? 0.5 : L.duty;
    const vol = L.vol === undefined ? 0.5 : L.vol;
    const arp = L.arp || null, arpStep = L.arpStep || 0.06;
    const vib = L.vib || null;
    const crushLevels = L.crush ? Math.pow(2, L.crush - 1) : 0;
    const noiseStep = makeLfsr();
    let phase = 0, lastIdx = -1, noiseVal = 1;
    for (let i = 0; i < n; i++) {
      const tt = i / sr - delay;
      if (tt < 0) continue;
      const env = tt < dur ? levelAt(L, tt) : (r > 0 ? relLevel * Math.max(0, 1 - (tt - dur) / r) : 0);
      const prog = Math.min(tt / dur, 1);
      let f = f0 * Math.pow(f1 / f0, prog);
      let semis = pitch;
      if (arp) semis += arp[Math.min(Math.floor(tt / arpStep), arp.length - 1)];
      f *= Math.pow(2, semis / 12);
      if (vib) f *= 1 + vib[1] * Math.sin(2 * Math.PI * vib[0] * tt);
      f = Math.min(f, sr * 0.45);
      phase += f / sr;
      const frac = phase - Math.floor(phase);
      let v;
      switch (L.wave) {
        case 'triangle': v = 1 - 4 * Math.abs(frac - 0.5); break;
        case 'saw': v = 2 * frac - 1; break;
        case 'sine': v = Math.sin(2 * Math.PI * phase); break;
        case 'noise': {
          const idx = Math.floor(phase);
          if (idx !== lastIdx) { noiseVal = noiseStep(); lastIdx = idx; }
          v = noiseVal; break;
        }
        default: v = frac < duty ? 1 : -1; // square / pulse
      }
      v *= env * vol;
      if (crushLevels) v = Math.round(v * crushLevels) / crushLevels;
      out[i] = v;
    }
    return out;
  }

  function synth(type, pitch, sr) {
    const layers = getPresets()[type];
    if (!layers || !Array.isArray(layers)) { console.warn('[retro_audio] unknown sfx', type); return new Float32Array(1); }
    const parts = layers.map(L => synthLayer(L, pitch || 0, sr));
    const n = Math.max(...parts.map(p => p.length));
    const out = new Float32Array(n);
    for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
    return out;
  }

  // ---- Live playback (preview mode only) ----
  let ctx = null, master = null;
  const cache = new Map();
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    return ctx;
  }
  function play(type, pitch, opts) {
    if (!ctx || ctx.state !== 'running') return;
    const key = type + '|' + (pitch || 0);
    let buf = cache.get(key);
    if (!buf) {
      const data = synth(type, pitch || 0, ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data, 0);
      cache.set(key, buf);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = (opts && opts.vol !== undefined) ? opts.vol : 1;
    let node = src.connect(g);
    if (ctx.createStereoPanner && opts && opts.pan) {
      const p = ctx.createStereoPanner(); p.pan.value = opts.pan; node.connect(p); node = p;
    }
    node.connect(master);
    src.start();
  }

  // ---- Event logger (the render's single source of truth for SFX) ----
  const events = [];
  let liveEnabled = false;

  window.logSfx = function (eventType, frameNumber, pitch, opts) {
    const fps = (window.Retro && window.Retro.FPS) || FPS_DEFAULT;
    const ev = {
      type: String(eventType),
      frame: frameNumber | 0,
      time: +((frameNumber | 0) / fps).toFixed(6),
      pitch: +(pitch || 0),
      vol: (opts && opts.vol !== undefined) ? +opts.vol : 1,
      pan: (opts && opts.pan !== undefined) ? +opts.pan : 0
    };
    events.push(ev);
    if (liveEnabled) play(ev.type, ev.pitch, ev);
    return ev;
  };
  window.getSfxEvents = function () { return events.slice(); };

  // ---- Continuous voices (logged every frame they are active)
  const synthStates = {};
  const live = {};            // preview: voice -> {osc, noise, g, ng, duty, wave, last}
  const waveCache = new Map();
  function pulseWave(duty) {
    const q = Math.round(duty * 20) / 20;
    if (waveCache.has(q)) return waveCache.get(q);
    const N = 64, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) { re[n] = (2 / (n * Math.PI)) * Math.sin(2 * Math.PI * n * q); im[n] = (2 / (n * Math.PI)) * (1 - Math.cos(2 * Math.PI * n * q)); }
    const w = ctx.createPeriodicWave(re, im); waveCache.set(q, w); return w;
  }
  function liveVoice(id, wave) {
    if (live[id]) return live[id];
    const osc = ctx.createOscillator();
    if (wave === 'triangle' || wave === 'sawtooth' || wave === 'sine') osc.type = wave;
    if (wave === 'saw') osc.type = 'sawtooth';
    const g = ctx.createGain(); g.gain.value = 0;
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const ng = ctx.createGain(); ng.gain.value = 0;
    osc.connect(g); noise.connect(ng); g.connect(master); ng.connect(master);
    osc.start(); noise.start();
    return (live[id] = { osc, noise, g, ng, duty: -1, wave, last: -1 });
  }
  window.logSynthState = function (frameNumber, freqHz, dutyCycle, gain, noiseLevel, opts) {
    const id = (opts && opts.voice) || 'main';
    const wave = (opts && opts.wave) || 'square';
    const v = synthStates[id] || (synthStates[id] = { wave, pan: (opts && opts.pan) || 0, frames: [] });
    const f = frameNumber | 0, hz = +freqHz || 0, duty = +(dutyCycle === undefined ? 0.5 : dutyCycle), gn = +(gain || 0), nz = +(noiseLevel || 0);
    if (v.frames.length && v.frames[v.frames.length - 1][0] === f) v.frames[v.frames.length - 1] = [f, hz, duty, gn, nz];
    else v.frames.push([f, +hz.toFixed(3), +duty.toFixed(4), +gn.toFixed(4), +nz.toFixed(4)]);
    if (liveEnabled && ctx && ctx.state === 'running') {
      const L = liveVoice(id, wave), t = ctx.currentTime;
      if (wave === 'square' && Math.abs(L.duty - duty) > 0.04) { L.osc.setPeriodicWave(pulseWave(duty)); L.duty = duty; }
      L.osc.frequency.setTargetAtTime(Math.max(1, hz), t, 0.01);
      L.g.gain.setTargetAtTime(gn * (1 - nz) * 0.6, t, 0.015);
      L.ng.gain.setTargetAtTime(gn * nz * 0.5, t, 0.015);
      L.last = f;
    }
  };
  window.getSynthStates = function () { return JSON.parse(JSON.stringify(synthStates)); };
  function endFrame(frame) {
    if (!ctx) return;
    for (const id in live) {
      const L = live[id];
      if (L.last !== frame) { L.g.gain.setTargetAtTime(0, ctx.currentTime, 0.02); L.ng.gain.setTargetAtTime(0, ctx.currentTime, 0.02); }
    }
  }

  window.RetroAudio = {
    synth,
    unlock() { const c = ensureCtx(); if (c && c.state !== 'running') c.resume(); liveEnabled = true; },
    setLive(on) { liveEnabled = !!on; if (!on && ctx) for (const id in live) { live[id].g.gain.value = 0; live[id].ng.gain.value = 0; } },
    clear() {
      events.length = 0;
      for (const k in synthStates) delete synthStates[k];
      if (ctx) for (const id in live) { live[id].g.gain.value = 0; live[id].ng.gain.value = 0; }
    },
    endFrame,
    get presets() { return getPresets(); }
  };
})();
