/* {{TITLE}} — V3 Visual-First episode (no narration). Channel: {{CHANNEL}}
 * Starter skeleton: replace the placeholder gear pair with the real mechanism.
 * V3 toolkit: R.hookBanner, R.micro (badge|warn|ok|tag|stamp|formula), R.formula, R.payoffStamp,
 * R.onBeat(div) / R.pulse(kind) / R.synth(voice,{freq,cutoff,res,...}) + everything from v2
 * (Camera, R.world, R.peel, R.force, R.flow, R.label, R.telemetry, R.gauge, R.scope, R.gear ...).
 * Colors: R.PAL roles only, so the channel theme controls the look.
 * Attention rules (QA-enforced): text <= 4 words, pops on its event then dims/clears (no bright static text > 5 s);
 *   open with a 3-4 word tension hook (0-2.2 s); focal zoom + R.spotlight() on every action; event-only audio
 *   (no constant hums/beds), engine adds clean 8-15 ms attacks / exponential releases and 75 ms spacing.
 * Safe zone: everything must stay inside R.SAFE (1080x1920 px 90..920 x 260..1480). --preview-only FAILS QA otherwise.
 *   Use Camera.track({fit:[x,y,w,h]}) / Camera.fitTo() / fitBoundsToSafeZone(); world text/boxes cut by the view
 *   edge are auto-hidden. Audio: notes are auto-snapped to C major pentatonic <= 880 Hz, 3-voice cap per bus.
 */
Retro.defineSim({
  defaultBeats: [{ id: 'hook', dur: 4 }, { id: 'core', dur: 12 }, { id: 'failure', dur: 10 }, { id: 'payoff', dur: 8 }],

  setup(R) {
    const S = R.state;
    S.b = { hook: R.beat('hook'), core: R.beat('core'), fail: R.beat('failure'), pay: R.beat('payoff') };
    S.angle = 0; S.steps = 0; S.stepT = 0;
    const b = S.b;
    // world view = UI-safe box minus the HUD strip at the bottom (safe box is x 90..920, y 260..1480 on 1080x1920)
    Camera.setView(R.SAFE.x, R.SAFE.y, R.SAFE.w, 255);
    // fit:[x,y,w,h] = world box that must stay fully visible; zoom is capped by fitBoundsToSafeZone()
    const ALL = [70, 170, 120, 70], DRIVE = [82, 176, 98, 58];
    Camera.track([
      { t: 0, fit: ALL, zoom: 1.4 },
      { t: b.core.start + 0.2, fit: ALL, zoom: 1.4 },
      { t: b.core.start + 1.0, fit: DRIVE, zoom: 2.4 },                   // zoom into the drive gear
      { t: b.fail.start, fit: DRIVE, zoom: 2.4 },
      { t: b.fail.start + 0.8, fit: ALL, zoom: 1.6 },
      { t: b.pay.start, fit: ALL, zoom: 1.6 },
      { t: b.pay.start + 0.8, x: 135, y: 160, zoom: 1 }                   // mechanism low, payoff stamp on top
    ]);
  },

  update(R, dt) {
    const S = R.state, t = R.t, b = S.b;
    const jam = t >= b.fail.start + 2 && t < b.pay.start;
    const rpm = jam ? 0 : t < b.pay.start ? 30 : 120;
    S.angle += rpm / 60 * Math.PI * 2 * dt;
    // event-only audio: one soft hop per mechanical step (no continuous hum)
    if (R.onBeat(1) && !jam && t >= b.core.start) { S.steps++; S.stepT = t; R.sfx('hop', S.steps % 8); }
    if (R.crossed(b.fail.start + 2)) { R.sfx('warn'); R.shake(3, 10); }
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, b = S.b, SAFE = R.SAFE;
    if (!R.theme.background) R.grid(0, 0, R.W, R.H, 15, P.grid);
    R.hookBanner('WHY DOES\nIT JAM?', { t0: 0, dur: 2.2 });             // 3-4 word tension hook, cleared by 2.2 s
    R.world(() => {
      // attention: spotlight the active part, everything else dims + desaturates
      if (t >= b.core.start + 1.0 && t < b.pay.start) R.spotlight(82, 176, 60, 58);
      R.gear(112, 205, 26, 12, S.angle, P.cyan, { hole: 5, shadow: true });
      R.gear(157, 205, 19, 9, -S.angle * 12 / 9 + 0.2, P.gold, { hole: 4, shadow: true });
      // declare the moving parts as active nodes -> QA fails if either is ever cut by the safe zone
      R.node(112 - 26, 205 - 26, 52, 52, 'drive gear'); R.node(157 - 19, 205 - 19, 38, 38, 'driven gear');
      R.micro('12 TEETH', 112, 180, { t0: b.core.start + 1.2, dur: 2.5, style: 'badge', color: P.cyan });
      R.micro('JAMMED!', 135, 205, { t0: b.fail.start + 2, dur: 3, style: 'warn' });
    });
    R.formula('RATIO = 12 / 9', SAFE.x + SAFE.w / 2, SAFE.y + 255 + 8, { t0: b.core.start + 4, dur: 6, at: [0, 0] });
    // reactive counter: pops on every step, dims in between (no always-on HUD)
    if (S.steps > 0) R.micro('STEP ' + S.steps, SAFE.x + SAFE.w / 2, SAFE.y + SAFE.h - 12, { t0: S.stepT, dur: 1e9, style: 'tag', color: P.cyan, pointer: false, fixed: true, at: [0, 0], dimAfter: 0.5 });
    R.payoffStamp('PAYOFF\nLINE HERE.', { t0: b.pay.start + 3, dur: 2.5, y: SAFE.y + 70 });
  }
});
