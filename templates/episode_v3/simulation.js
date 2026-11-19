/* {{TITLE}} — V3 Visual-First episode (no narration). Channel: {{CHANNEL}}
 * Starter skeleton: replace the placeholder gear pair with the real mechanism.
 * V3 toolkit: R.hookBanner, R.micro (badge|warn|ok|tag|stamp|formula), R.formula, R.payoffStamp,
 * R.onBeat(div) / R.pulse(kind) / R.synth(voice,{freq,cutoff,res,...}) + everything from v2
 * (Camera, R.world, R.peel, R.force, R.flow, R.label, R.telemetry, R.gauge, R.scope, R.gear ...).
 * Colors: R.PAL roles only, so the channel theme controls the look.
 */
Retro.defineSim({
  defaultBeats: [{ id: 'hook', dur: 4 }, { id: 'core', dur: 12 }, { id: 'failure', dur: 10 }, { id: 'payoff', dur: 8 }],

  setup(R) {
    const S = R.state;
    S.b = { hook: R.beat('hook'), core: R.beat('core'), fail: R.beat('failure'), pay: R.beat('payoff') };
    S.angle = 0; S.steps = 0;
    Camera.setView(R.SAFE.x, R.SAFE.y, R.SAFE.w, 300);          // world above the HUD strip
    const b = S.b, home = { x: 135, y: 205 };
    Camera.track([
      { t: 0, x: home.x, y: home.y, zoom: 1 },
      { t: b.core.start + 0.2, x: home.x, y: home.y, zoom: 1 },
      { t: b.core.start + 1.0, x: 118, y: 205, zoom: 2.0 },
      { t: b.fail.start, x: 118, y: 205, zoom: 2.0 },
      { t: b.fail.start + 0.8, x: home.x, y: home.y, zoom: 1.3 },
      { t: b.pay.start, x: home.x, y: home.y, zoom: 1.3 },
      { t: b.pay.start + 0.8, x: home.x, y: 180, zoom: 1 }
    ]);
  },

  update(R, dt) {
    const S = R.state, t = R.t, b = S.b;
    const jam = t >= b.fail.start + 2 && t < b.pay.start;
    const rpm = jam ? 0 : t < b.pay.start ? 30 : 120;
    S.angle += rpm / 60 * Math.PI * 2 * dt;
    if (R.onBeat(1) && !jam && t >= b.core.start) { S.steps++; R.sfx('hop', S.steps % 8); }
    if (R.crossed(b.fail.start + 2)) { R.sfx('warn'); R.pulse('kick', { accent: 1 }); R.shake(3, 10); }
    // continuous voice: pitch + filter follow the mechanism's speed
    R.synth('drive', { freq: 50 + rpm, duty: 0.3, gain: jam ? 0 : 0.15, cutoff: 300 + rpm * 20, res: 0.4, wave: 'saw' });
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, b = S.b, SAFE = R.SAFE;
    if (!R.theme.background) R.grid(0, 0, R.W, R.H, 15, P.grid);
    R.hookBanner('{{TITLE}}', { t0: 0, dur: 3.3, sub: 'WATCH THE GEARS' });
    R.world(() => {
      R.gear(112, 205, 26, 12, S.angle, P.cyan, { hole: 5, shadow: true });
      R.gear(157, 205, 19, 9, -S.angle * 12 / 9 + 0.2, P.gold, { hole: 4, shadow: true });
      R.micro('12 TEETH', 112, 180, { t0: b.core.start + 1.2, dur: 3, style: 'badge', color: P.cyan });
      R.micro('JAMMED!', 135, 205, { t0: b.fail.start + 2, dur: 4, style: 'warn' });
    });
    R.formula('RATIO = 12 / 9', R.W / 2, SAFE.y + SAFE.h - 40, { t0: b.core.start + 4, dur: 6, at: [0, 0] });
    R.telemetry(SAFE.x, SAFE.y + SAFE.h - 28, SAFE.w, [{ label: 'STEPS', value: S.steps, color: P.cyan }, { label: 'STATE', value: t >= b.fail.start + 2 && t < b.pay.start ? 'JAM' : 'OK', color: P.gold }]);
    R.payoffStamp('PAYOFF\nLINE HERE.', { t0: b.pay.start + 3, y: SAFE.y + 70 });
  }
});
