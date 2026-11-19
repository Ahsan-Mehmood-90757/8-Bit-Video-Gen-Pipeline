/* synth_engine.js — V3 musical audio engine for the LIVE PREVIEW (Web Audio).
 * pipeline_v3/synth_v3.py implements the identical rules for the final MP4 soundtrack.
 *
 * Master chain (every procedural voice):
 *   voiceGain (max 0.16) -> BiquadFilter lowpass 2000 Hz, Q 0.8 -> DynamicsCompressor
 *   (threshold -18, knee 12, ratio 12, attack 0.003, release 0.15) -> masterGain 0.75 -> destination
 *
 * Polyphony: strict 3 one-shot voices per bus (sfx bus, rhythm bus); when a 4th triggers, the oldest
 * fades out in 15 ms, so rapid loops never stack volume.
 *
 * Musical mode: every pitched layer is snapped to C major pentatonic
 *   [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25] (+ octaves), folded down to <= 880 Hz,
 *   and raw square/saw waves become warm triangles (>= 200 Hz) or low filtered pulses (< 200 Hz).
 */
(function () {
  'use strict';
  const CFG = {
    voiceGain: 0.16, lowpassHz: 2000, lowpassQ: 0.8,
    comp: { threshold: -18, knee: 12, ratio: 12, attack: 0.003, release: 0.15 },
    masterGain: 0.75, polyphony: 3, stealFade: 0.015, maxHz: 880, musical: true
  };
  const PENTA = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];
  const NOTES = [];
  for (let o = -5; o <= 4; o++) for (const f of PENTA.slice(0, 5)) NOTES.push(f * Math.pow(2, o));
  NOTES.sort((a, b) => a - b);

  function snap(f) {                       // nearest pentatonic note, any octave
    if (!(f > 0)) return f;
    let best = NOTES[0], bd = Infinity;
    for (const n of NOTES) { const d = Math.abs(Math.log2(f / n)); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function quantize(f) { let q = snap(f); while (q > CFG.maxHz + 1e-6) q /= 2; return +q.toFixed(4); }
  // Convert preset layers + semitone pitch into musical layers (pitch baked in). Mirrors synth_v3.musicalize().
  function musicalize(layers, pitch) {
    const k = Math.pow(2, (pitch || 0) / 12);
    return layers.map((L0) => {
      const L = Object.assign({}, L0);
      const f0 = (L.freq || 440) * k, f1 = (L.freqEnd === undefined ? L.freq || 440 : L.freqEnd) * k;
      if (L.wave === 'noise') { L.freq = f0; L.freqEnd = f1; return L; }
      if (!CFG.musical) { L.freq = Math.min(f0, CFG.maxHz); L.freqEnd = Math.min(f1, CFG.maxHz); return L; }
      let q0 = snap(f0), q1 = Math.abs(f1 - f0) < 1e-6 ? q0 : snap(f1);
      const arpHz = (L.arp || []).map(a => snap(q0 * Math.pow(2, a / 12)));
      const top = Math.max(q0, q1, ...arpHz);
      const fold = Math.pow(2, Math.max(0, Math.ceil(Math.log2(top / CFG.maxHz) - 1e-9)));   // whole-octave shift
      q0 = +(q0 / fold).toFixed(4); q1 = +(q1 / fold).toFixed(4);
      if (L.arp) L.arp = arpHz.map(h => 12 * Math.log2((h / fold) / q0));
      if (L.wave === 'square' || L.wave === 'saw' || L.wave === undefined) {
        if (q0 >= 200) L.wave = 'triangle'; else { L.wave = 'square'; L.duty = 0.5; }
      }
      L.freq = q0; L.freqEnd = q1;
      return L;
    });
  }

  // ---- same oscillator/ADSR/LFSR algorithm as engine/retro_audio.js + pipeline/synth_sfx.py
  function makeLfsr() { let r = 1; return () => { const fb = (r & 1) ^ ((r >> 1) & 1); r = (r >> 1) | (fb << 14); return (r & 1) ? -1 : 1; }; }
  function levelAt(L, t) {
    const a = L.a || 0, d = L.d || 0, s = L.s === undefined ? 1 : L.s;
    if (t < a) return a > 0 ? t / a : 1;
    if (t < a + d) return d > 0 ? 1 - (1 - s) * (t - a) / d : s;
    return s;
  }
  function synthLayer(L, sr) {
    const delay = L.delay || 0, dur = Math.max(L.dur || 0.05, 1e-4), r = L.r || 0;
    const n = Math.ceil((delay + dur + r) * sr) + 1, out = new Float32Array(n);
    const rel = levelAt(L, dur), f0 = L.freq || 440, f1 = L.freqEnd || f0, duty = L.duty === undefined ? 0.5 : L.duty;
    const vol = L.vol === undefined ? 0.5 : L.vol, arp = L.arp, arpStep = L.arpStep || 0.06, vib = L.vib;
    const crush = L.crush ? Math.pow(2, L.crush - 1) : 0, nz = makeLfsr();
    let ph = 0, last = -1, nv = 1;
    for (let i = 0; i < n; i++) {
      const tt = i / sr - delay; if (tt < 0) continue;
      const env = tt < dur ? levelAt(L, tt) : (r > 0 ? rel * Math.max(0, 1 - (tt - dur) / r) : 0);
      let f = f0 * Math.pow(f1 / f0, Math.min(tt / dur, 1));
      if (arp) f *= Math.pow(2, arp[Math.min(Math.floor(tt / arpStep), arp.length - 1)] / 12);
      if (vib) f *= 1 + vib[1] * Math.sin(2 * Math.PI * vib[0] * tt);
      f = Math.min(f, sr * 0.45);
      ph += f / sr;
      const fr = ph - Math.floor(ph);
      let v;
      if (L.wave === 'triangle') v = 1 - 4 * Math.abs(fr - 0.5);
      else if (L.wave === 'saw') v = 2 * fr - 1;
      else if (L.wave === 'sine') v = Math.sin(2 * Math.PI * ph);
      else if (L.wave === 'noise') { const idx = Math.floor(ph); if (idx !== last) { nv = nz(); last = idx; } v = nv; }
      else v = fr < duty ? 1 : -1;
      v *= env * vol;
      if (crush) v = Math.round(v * crush) / crush;
      out[i] = v;
    }
    return out;
  }

  // ---- Web Audio graph
  let ctx = null, bus = null, live = true;
  const cache = new Map(), active = { sfx: [], rhythm: [] }, voices = {};
  const presets = () => Object.assign({}, window.SFX_PRESETS || {}, window.CHANNEL_SFX_PRESETS || {});
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    const T = window.EPISODE_TIMELINE && window.EPISODE_TIMELINE.audio;
    if (T) Object.assign(CFG, T, { comp: Object.assign({}, CFG.comp, T.comp || {}) });
    bus = ctx.createGain(); bus.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = CFG.lowpassHz; lp.Q.value = CFG.lowpassQ;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = CFG.comp.threshold; comp.knee.value = CFG.comp.knee; comp.ratio.value = CFG.comp.ratio;
    comp.attack.value = CFG.comp.attack; comp.release.value = CFG.comp.release;
    const master = ctx.createGain(); master.gain.value = CFG.masterGain;
    bus.connect(lp); lp.connect(comp); comp.connect(master); master.connect(ctx.destination);
    return ctx;
  }
  function play(type, pitch, o = {}, which = 'sfx') {
    if (!live || !ctx || ctx.state !== 'running') return;
    const layers = presets()[type]; if (!layers) return;
    const key = type + '|' + (pitch || 0);
    let buf = cache.get(key);
    if (!buf) {
      const parts = musicalize(layers, pitch).map(L => synthLayer(L, ctx.sampleRate));
      const n = Math.max(...parts.map(p => p.length)), data = new Float32Array(n);
      for (const p of parts) for (let i = 0; i < p.length; i++) data[i] += p[i];
      buf = ctx.createBuffer(1, n, ctx.sampleRate); buf.copyToChannel(data, 0); cache.set(key, buf);
    }
    const now = ctx.currentTime, list = active[which];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= now) list.splice(i, 1);
    while (list.length >= CFG.polyphony) {                       // steal the oldest voice
      const old = list.shift();
      old.g.gain.cancelScheduledValues(now); old.g.gain.setValueAtTime(old.g.gain.value, now);
      old.g.gain.linearRampToValueAtTime(0, now + CFG.stealFade);
      try { old.src.stop(now + CFG.stealFade + 0.005); } catch (e) { /* already stopped */ }
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = Math.min(CFG.voiceGain, CFG.voiceGain * (o.vol === undefined ? 1 : o.vol));
    let node = src.connect(g);
    if (ctx.createStereoPanner && o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; node.connect(p); node = p; }
    node.connect(bus);
    src.start(now);
    list.push({ src, g, start: now, end: now + buf.duration });
  }
  function voice(id, o) {
    if (!live || !ctx || ctx.state !== 'running') return;
    let V = voices[id];
    if (!V) {
      const osc = ctx.createOscillator();
      osc.type = o.wave === 'triangle' ? 'triangle' : o.wave === 'sine' ? 'sine' : o.wave === 'saw' ? 'sawtooth' : 'square';
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 20000;
      const g = ctx.createGain(); g.gain.value = 0;
      osc.connect(f); f.connect(g); g.connect(bus); osc.start();
      V = voices[id] = { osc, f, g, last: -1 };
    }
    const t = ctx.currentTime;
    V.osc.frequency.setTargetAtTime(Math.max(1, Math.min(CFG.maxHz, o.freq || 110)), t, 0.01);
    V.f.frequency.setTargetAtTime(o.cutoff > 0 ? o.cutoff : 20000, t, 0.01);
    V.f.Q.setTargetAtTime(0.7 + (o.res || 0) * 10, t, 0.02);
    V.g.gain.setTargetAtTime(CFG.voiceGain * Math.min(1, o.gain || 0), t, 0.015);
    V.last = o.frame;
  }
  function endFrame(frame) {
    if (!ctx) return;
    for (const id in voices) if (voices[id].last !== frame) voices[id].g.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  }
  function silence() { if (!ctx) return; for (const id in voices) voices[id].g.gain.value = 0; }

  window.SynthEngineV3 = {
    CFG, PENTA, quantize, musicalize, synthLayer,
    unlock() { const c = ensure(); if (c && c.state !== 'running') c.resume(); live = true; },
    setLive(on) { live = !!on; if (!on) silence(); },
    play, voice, endFrame, silence
  };

  // hook into the engine's preview controls (RetroAudio is still the engine-facing object)
  const RA = window.RetroAudio;
  if (RA) {
    const u = RA.unlock.bind(RA), s = RA.setLive.bind(RA), e = RA.endFrame ? RA.endFrame.bind(RA) : null, c = RA.clear.bind(RA);
    RA.unlock = () => { u(); RA.setLive(false); window.SynthEngineV3.unlock(); };   // v2 preview synth stays muted in v3
    RA.setLive = (on) => { s(false); window.SynthEngineV3.setLive(on); };
    RA.endFrame = (f) => { if (e) e(f); window.SynthEngineV3.endFrame(f); };
    RA.clear = () => { c(); silence(); };
  }
})();
