/* audio_events_v3.js — frame-exact audio logger for the Visual-First (zero-TTS) pipeline.
 * Load AFTER engine/retro_audio.js (which still provides the live browser preview synth).
 *
 *   window.logSfxV3(type, frame, pitch, {vol, pan})            discrete hits (presets: v2 library + engine_v3/sfx_presets_v3.js)
 *   window.logSynthStateV3(frame, {voice, freq, duty, gain, noise, cutoff, res, wave, pan})
 *                                                              continuous voices with frequency AND low-pass filter modulation
 *   window.logBeatPulseV3(frame, {kind:'kick'|'bass'|'hat'|'snare', note:'A1'|semitones, accent:0..1, pan})
 *                                                              rhythmic pulses accenting mechanical steps
 *   window.getAudioLogV3() -> {version:3, fps, events:[...], synth:{voice:{wave,pan,frames:[[f,hz,duty,gain,noise,cutoff,res]]}}, pulses:[...]}
 *
 * The v2 names (window.logSfx / window.logSynthState) are routed here too, so R.sfx() and R.hum()
 * keep working in v3 episodes. pipeline_v3/synth_v3.py renders the log sample-accurately.
 */
(function () {
  'use strict';
  const FPS = 60;
  // live preview playback goes through engine_v3/synth_engine.js (master chain, 3-voice cap, pentatonic)
  const SE = () => window.SynthEngineV3;
  const events = [], pulses = [], synth = {};

  const NOTE = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
  // semitones relative to A1 (55 Hz) — the base pitch of the 'bass' preset
  function noteToSemis(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(String(n || 'A1').trim());
    if (!m) return 0;
    const pc = NOTE[m[1].toUpperCase()], oct = parseInt(m[2], 10);
    return (oct * 12 + pc) - (1 * 12 + 9);
  }
  window.noteToSemisV3 = noteToSemis;

  window.logSfxV3 = function (type, frame, pitch, o) {
    const ev = { type: String(type), frame: frame | 0, time: +((frame | 0) / FPS).toFixed(6), pitch: +(pitch || 0),
      vol: o && o.vol !== undefined ? +o.vol : 1, pan: o && o.pan !== undefined ? +o.pan : 0 };
    events.push(ev);
    if (SE()) SE().play(ev.type, ev.pitch, ev, 'sfx');            // live preview sound
    return ev;
  };

  window.logSynthStateV3 = function (frame, o) {
    o = o || {};
    const id = o.voice || 'main', f = frame | 0;
    const v = synth[id] || (synth[id] = { wave: o.wave || 'square', pan: +(o.pan || 0), frames: [] });
    const row = [f, +(+o.freq || 0).toFixed(3), +(o.duty === undefined ? 0.5 : o.duty).toFixed(4), +(+o.gain || 0).toFixed(4),
      +(+o.noise || 0).toFixed(4), o.cutoff === undefined ? 0 : Math.round(+o.cutoff), +(+(o.res || 0)).toFixed(3)];
    if (v.frames.length && v.frames[v.frames.length - 1][0] === f) v.frames[v.frames.length - 1] = row; else v.frames.push(row);
    if (SE()) SE().voice(id, { freq: row[1], gain: row[3], cutoff: row[5], res: row[6], wave: v.wave, frame: f });
  };

  window.logBeatPulseV3 = function (frame, o) {
    o = o || {};
    const kind = o.kind || 'bass';
    const p = { kind, frame: frame | 0, semis: kind === 'bass' ? noteToSemis(o.note) : +(o.pitch || 0),
      accent: o.accent === undefined ? 0.7 : Math.max(0, Math.min(1, +o.accent)), pan: +(o.pan || 0) };
    pulses.push(p);
    if (SE()) SE().play(kind, p.semis, { vol: 0.35 + 0.65 * p.accent, pan: p.pan }, 'rhythm');
    return p;
  };

  // v2 names -> v3 logger (so R.sfx / R.hum work unchanged)
  window.logSfx = (type, frame, pitch, o) => window.logSfxV3(type, frame, pitch, o);
  window.logSynthState = (frame, hz, duty, gain, noise, o) =>
    window.logSynthStateV3(frame, Object.assign({ freq: hz, duty, gain, noise }, o || {}));

  window.getAudioLogV3 = () => JSON.parse(JSON.stringify({ version: 3, fps: FPS, events, synth, pulses }));
  window.getSfxEvents = () => events.slice();
  window.getSynthStates = () => JSON.parse(JSON.stringify(synth));

  // clear on engine reset (preview restart / seek)
  const ra = window.RetroAudio;
  if (ra) {
    const origClear = ra.clear.bind(ra);
    ra.clear = function () { origClear(); events.length = 0; pulses.length = 0; for (const k in synth) delete synth[k]; };
  }
})();
