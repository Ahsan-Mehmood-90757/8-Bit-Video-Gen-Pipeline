window.SFX_PRESETS_V3 = {
  "_doc": "V3 additions: rhythm voices for logBeatPulseV3 (kick/bass/hat/snare) + visual-first UI sounds. Same layer format as engine/sfx_presets.js. Merged ON TOP of the v2 library for v3 pages/renders only. Keep this file strict JSON between the '=' and the closing '};' line.",
  "kick":   [{"wave": "triangle", "freq": 160, "freqEnd": 42, "dur": 0.11, "a": 0.001, "d": 0.1, "s": 0.0, "r": 0.04, "vol": 1.0},
             {"wave": "noise", "freq": 6000, "freqEnd": 2000, "dur": 0.008, "a": 0.0005, "d": 0.007, "s": 0.0, "r": 0.004, "vol": 0.25}],
  "bass":   [{"wave": "triangle", "freq": 55, "freqEnd": 55, "dur": 0.16, "a": 0.003, "d": 0.12, "s": 0.35, "r": 0.06, "vol": 0.9},
             {"wave": "square", "duty": 0.25, "freq": 110, "freqEnd": 110, "dur": 0.05, "a": 0.002, "d": 0.04, "s": 0.0, "r": 0.02, "vol": 0.12}],
  "hat":    [{"wave": "noise", "freq": 12000, "freqEnd": 9000, "dur": 0.02, "a": 0.0005, "d": 0.018, "s": 0.0, "r": 0.01, "vol": 0.22}],
  "snare":  [{"wave": "noise", "freq": 5000, "freqEnd": 2500, "dur": 0.09, "a": 0.001, "d": 0.08, "s": 0.0, "r": 0.04, "vol": 0.45},
             {"wave": "triangle", "freq": 220, "freqEnd": 150, "dur": 0.05, "a": 0.001, "d": 0.04, "s": 0.0, "r": 0.02, "vol": 0.5}],
  "pop":    [{"wave": "square", "duty": 0.25, "freq": 900, "freqEnd": 1800, "dur": 0.035, "a": 0.001, "d": 0.03, "s": 0.0, "r": 0.015, "vol": 0.35}],
  "hop":    [{"wave": "square", "duty": 0.5, "freq": 660, "freqEnd": 990, "dur": 0.045, "a": 0.001, "d": 0.035, "s": 0.2, "r": 0.02, "vol": 0.3}],
  "wrap":   [{"wave": "square", "duty": 0.25, "freq": 523.25, "freqEnd": 523.25, "dur": 0.16, "a": 0.002, "d": 0.04, "s": 0.6, "r": 0.06, "vol": 0.32, "arp": [0, 7, 12], "arpStep": 0.045}],
  "warn":   [{"wave": "square", "duty": 0.5, "freq": 740, "freqEnd": 740, "dur": 0.42, "a": 0.002, "d": 0.02, "s": 0.85, "r": 0.04, "vol": 0.28, "arp": [0, -6, 0, -6], "arpStep": 0.1},
             {"wave": "saw", "freq": 92.5, "freqEnd": 92.5, "dur": 0.42, "a": 0.003, "d": 0.1, "s": 0.6, "r": 0.05, "vol": 0.18, "crush": 4}],
  "stamp":  [{"wave": "triangle", "freq": 130, "freqEnd": 50, "dur": 0.14, "a": 0.001, "d": 0.12, "s": 0.0, "r": 0.05, "vol": 1.0},
             {"wave": "noise", "freq": 3000, "freqEnd": 600, "dur": 0.08, "a": 0.001, "d": 0.07, "s": 0.0, "r": 0.04, "vol": 0.4},
             {"wave": "square", "duty": 0.5, "freq": 523.25, "freqEnd": 523.25, "dur": 0.42, "delay": 0.05, "a": 0.002, "d": 0.05, "s": 0.7, "r": 0.2, "vol": 0.28, "arp": [0, 4, 7, 12, 16], "arpStep": 0.06}],
  "evict":  [{"wave": "saw", "freq": 880, "freqEnd": 180, "dur": 0.16, "a": 0.002, "d": 0.12, "s": 0.2, "r": 0.05, "vol": 0.26}],
  "hit":    [{"wave": "square", "duty": 0.125, "freq": 1320, "freqEnd": 1320, "dur": 0.07, "a": 0.001, "d": 0.03, "s": 0.4, "r": 0.04, "vol": 0.3, "arp": [0, 5], "arpStep": 0.035}],
  "swoosh": [{"wave": "noise", "freq": 800, "freqEnd": 7000, "dur": 0.22, "a": 0.1, "d": 0.08, "s": 0.4, "r": 0.08, "vol": 0.22}],
  "banner": [{"wave": "triangle", "freq": 98, "freqEnd": 49, "dur": 0.16, "a": 0.001, "d": 0.14, "s": 0.0, "r": 0.06, "vol": 1.0},
             {"wave": "square", "duty": 0.5, "freq": 392, "freqEnd": 392, "dur": 0.2, "a": 0.002, "d": 0.04, "s": 0.6, "r": 0.08, "vol": 0.26, "arp": [0, 12], "arpStep": 0.06}]
};
Object.assign(window.SFX_PRESETS = window.SFX_PRESETS || {}, window.SFX_PRESETS_V3);
