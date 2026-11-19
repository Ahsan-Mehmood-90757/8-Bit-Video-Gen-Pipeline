/* test_depth_fx_v3 — feature test for the density / depth / pacing upgrade (16 s, no narration).
 * Single-cylinder engine cutaway built from 2.5D extruded walls; piston + crank pin leave motion trails;
 * sparks burst on every power stroke; intake / exhaust flow dots; slow-mo (x0.15) with a focal zoom on the
 * chamber; STEP MODE; the speed badge reacts; the music bed follows the simulation speed (render + preview).
 */
const E = { cx: 126, cy: 271, r: 20, L: 62, boreL: 102, boreR: 150, head: 160 };
const T = { slowIn: 6.0, slowOut: 10.5, stepIn: 11.6, stepOut: 13.0, stamp: 13.4 };

Retro.defineSim({
  seed: 5,
  defaultBeats: [{ id: 'hook', dur: 2.2 }, { id: 'run', dur: 3.8 }, { id: 'slowmo', dur: 4.5 }, { id: 'step', dur: 2.5 }, { id: 'payoff', dur: 3 }],

  setup(R) {
    const S = R.state;
    S.deg = 30; S.lastSparkCycle = -1; S.stepNext = T.stepIn; S.lastStroke = -1;
    const ALL = [36, 140, 182, 178], CHAMBER = [92, 146, 68, 58];   // ALL covers ports + extrusion depth
    Camera.track([
      { t: 0, fit: ALL, zoom: 1.35 },
      { t: T.slowIn - 0.1, fit: ALL, zoom: 1.35 },
      { t: T.slowIn + 0.7, fit: CHAMBER, zoom: 2.6 },              // focal zoom while in slow-mo
      { t: T.slowOut, fit: CHAMBER, zoom: 2.6 },
      { t: T.slowOut + 0.6, fit: ALL, zoom: 1.35 }
    ]);
  },

  update(R) {
    const S = R.state, t = R.t;
    // ---- time control: slow-mo, then step mode (the groove follows automatically)
    if (R.crossed(T.slowIn)) { R.setTimeScale(0.15, 0.5); R.sfx('swoosh', 0, { vol: 0.8 }); }
    if (R.crossed(T.slowOut)) { R.setTimeScale(1.0, 0.4); R.sfx('powerup', 0, { vol: 0.7 }); }
    if (R.crossed(T.stepIn)) { R.setStepMode(true); R.setTimeScale(0.6, 0.2); }
    if (R.crossed(T.stepOut)) { R.setStepMode(false); R.setTimeScale(1.0, 0.3); }

    // ---- crank: continuous (4 rev/s real time) or 90-degree steps in STEP MODE
    if (R.stepMode) {
      if (t >= S.stepNext) { S.deg += 90; S.stepNext += 0.28; R.sfx('click', 5, { vol: 0.9 }); }
    } else S.deg += 4 * 360 * R.simDt;

    const cycle = Math.floor(S.deg / 720), cyc = ((S.deg % 720) + 720) % 720, stroke = Math.floor(cyc / 180);
    S.cyc = cyc; S.stroke = stroke;
    // power stroke: spark burst + thud (envelopes stretch automatically in slow-mo)
    if (cyc >= 360 && cyc < 540 && S.lastSparkCycle !== cycle) {
      S.lastSparkCycle = cycle; S.sparkT = t;
      R.world(() => R.emit(R.timeScale < 0.5 ? 28 : 14, { x: E.cx, y: E.head + 3, angle: Math.PI / 2, spread: 1.2, speed: [0.8, 2.2], drag: 0.08, life: [0.25, 0.6], kind: 'spark', color: ['#FACC15', '#FFFFFF', '#FB923C'] }));
      R.sfx('thud', 0, { vol: 0.9 });
      if (R.timeScale < 0.5) R.sfx('pop', 4, { vol: 0.8 });
    }
    // exhaust puffs on the exhaust stroke
    if (stroke === 3 && S.lastStroke !== 3) R.world(() => R.emit(10, { x: E.boreR + 30, y: E.head - 6, angle: 0, spread: 0.5, speed: [0.6, 1.4], drag: 0.03, life: [0.6, 1.2], kind: 'dot', size: 2, color: ['#94A3B8', '#64748B'] }));
    S.lastStroke = stroke;
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, A = R.SAFE;
    R.grid(0, 0, R.W, R.H, 12, P.grid);
    R.world(() => {
      const a = S.deg * Math.PI / 180;
      const px = E.cx + E.r * Math.sin(a), py = E.cy - E.r * Math.cos(a);
      const pinY = E.cy - E.r * Math.cos(a) - Math.sqrt(E.L * E.L - Math.pow(E.r * Math.sin(a), 2));
      const top = pinY - 14;
      // crank housing + cylinder walls + head: 2.5D extruded cross-sections
      R.wall25d(80, 250, 92, 52, { face: '#1C2A40', depth: 6 });
      R.rect(E.boreL, E.head + 16, E.boreR - E.boreL, 100, '#05070D');                  // bore interior
      // chamber gas: flame in the power stroke, cool mix otherwise
      const gasH = top - (E.head + 16);
      if (S.stroke === 2 && gasH > 0) {
        const k = R.clamp((t - (S.sparkT || 0)) / (R.timeScale < 0.5 ? 1.2 : 0.18), 0, 1);
        R.rect(E.boreL, E.head + 16, E.boreR - E.boreL, gasH, '#3B2008');
        R.circle(E.cx, E.head + 18, 4 + 20 * k, '#FB923C'); R.circle(E.cx, E.head + 18, 2 + 11 * k, '#FACC15');
      } else if (gasH > 0) R.dither(E.boreL, E.head + 16, E.boreR - E.boreL, gasH, S.stroke === 3 ? '#475569' : '#0E4A6B', R.frame & 1);
      // piston (2.5D), connecting rod, crank
      R.wall25d(E.boreL + 1, top, E.boreR - E.boreL - 2, 26, { face: '#CBD5E1', depth: 4, hatch: false });
      R.rect(E.boreL + 1, top + 5, E.boreR - E.boreL - 2, 1, '#64748B'); R.rect(E.boreL + 1, top + 8, E.boreR - E.boreL - 2, 1, '#64748B');
      R.link(E.cx, pinY, px, py, 7, '#94A3B8', { outline: '#05070D', outlineW: 1 });
      R.circle(E.cx, E.cy, 15, '#FACC15', { outline: '#05070D', outlineW: 1, shadow: true });
      R.circle(px, py, 4, '#FFFFFF', { outline: '#05070D', outlineW: 1 });
      R.trail('pin', px, py, { n: R.timeScale < 0.5 ? 14 : 8, color: '#FACC15', size: 3 });
      R.trail('piston', E.cx, top + 13, { n: 6, color: '#38BDF8', size: 2 });
      R.wall25d(91, E.head + 16, 10, 100, { face: '#22324D', depth: 6 });
      R.wall25d(E.boreR, E.head + 16, 10, 100, { face: '#22324D', depth: 6 });
      R.wall25d(85, E.head, 82, 16, { face: '#2A3C5C', depth: 6 });
      R.rect(E.cx - 3, E.head - 12, 6, 14, '#E2E8F0'); R.rect(E.cx - 5, E.head - 4, 10, 4, '#64748B');   // spark plug
      // intake / exhaust ports with flow dots on their strokes
      R.wall25d(40, E.head + 2, 45, 10, { face: '#1E2B44', depth: 4, hatch: false });
      R.wall25d(167, E.head + 2, 45, 10, { face: '#1E2B44', depth: 4, hatch: false });
      if (S.stroke === 0) R.flowDots([[42, E.head + 7], [85, E.head + 7], [110, E.head + 20]], { speed: 60, spacing: 7, color: '#38BDF8' });
      if (S.stroke === 3) R.flowDots([[142, E.head + 20], [167, E.head + 7], [210, E.head + 7]], { speed: 60, spacing: 7, color: '#FB923C' });
      // attention: chamber spotlight during slow-mo
      if (t >= T.slowIn && t < T.slowOut) R.spotlight(92, 146, 68, 58, { dim: 0.55 });
      // declare what must stay fully visible: the whole engine in overview, the chamber while zoomed in
      if (t > T.slowIn - 0.1 && t < T.slowOut + 0.6) R.node(E.boreL, E.head - 12, E.boreR - E.boreL, 40, 'chamber');
      else R.node(40, E.head - 12, 176, 160, 'engine');
    });

    // ---- reactive text + HUD
    R.hookBanner('WATCH IT IN\nSLOW-MO', { t0: 0, dur: 2.2 });
    R.speedBadge({ from: 2.2 });                                       // appears once the hook banner has cleared
    const cx = A.x + A.w / 2;
    R.micro('4-STROKE CYCLE', cx, A.y + A.h - 22, { t0: 2.4, dur: 1.4, style: 'tag', pointer: false, fixed: true, at: [0, 0] });
    R.micro('SPARK!', cx, A.y + A.h - 22, { t0: T.slowIn + 1.2, dur: 1.0, style: 'warn', pointer: false, fixed: true, at: [0, 0] });
    R.micro('FLAME FRONT', cx, A.y + A.h - 22, { t0: T.slowIn + 2.4, dur: 1.6, style: 'badge', pointer: false, fixed: true, at: [0, 0] });
    R.micro('BACK TO REAL TIME', cx, A.y + A.h - 22, { t0: T.slowOut + 0.1, dur: 1.0, style: 'ok', pointer: false, fixed: true, at: [0, 0] });
    R.micro('90° PER STEP', cx, A.y + A.h - 22, { t0: T.stepIn + 0.1, dur: 1.2, style: 'tag', pointer: false, fixed: true, at: [0, 0] });
    R.payoffStamp('SPEED REVEALS\nDETAIL.', { t0: T.stamp, dur: 2.6, y: A.y + 48 });
  }
});
