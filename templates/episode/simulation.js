/* {{TITLE}} — episode simulation (channel: {{CHANNEL}})
 * Starter skeleton showing the v2 toolkit: camera, cutaway peel, leader labels, force arrows,
 * physics-coupled hum, telemetry. Replace the placeholder gear pair with the real mechanism.
 * Colors: use R.PAL roles only (cyan, gold, coral, emerald, violet, orange, panel, dim, ...).
 */
Retro.defineSim({
  defaultBeats: [{ id: 'hook', dur: 7 }, { id: 'zoom', dur: 14 }, { id: 'failure', dur: 10 }, { id: 'fullspeed', dur: 9 }],

  setup(R) {
    const S = R.state;
    Camera.setView(R.SAFE.x, R.SAFE.y + 14, R.SAFE.w, R.SAFE.h - 14);   // world drawn inside the safe zone
    const hook = R.beat('hook'), zoom = R.beat('zoom'), fail = R.beat('failure'), full = R.beat('fullspeed');
    S.peelT = R.wordAt('open', 'hook', hook.start + hook.dur * 0.35);
    S.angle = 0;
    // Camera choreography as keyframes (pure function of time -> seeking/QA safe)
    Camera.track([
      { t: 0, x: 135, y: 186, zoom: 1 },
      { t: zoom.start, x: 135, y: 186, zoom: 1 },
      { t: zoom.start + 1.2, x: 118, y: 170, zoom: 2.2 },
      { t: fail.start, x: 118, y: 170, zoom: 2.2 },
      { t: fail.start + 1.0, x: 135, y: 180, zoom: 1.5 },
      { t: full.start, x: 135, y: 180, zoom: 1.5 },
      { t: full.start + 1.2, x: 135, y: 186, zoom: 1 }
    ]);
    S.fail = fail; S.full = full; S.zoom = zoom;
  },

  update(R, dt) {
    const S = R.state, t = R.t;
    const rpm = t < S.full.start ? 30 : R.lerp(30, 240, R.clamp((t - S.full.start) / 3, 0, 1));
    S.rpm = rpm;
    S.angle += rpm / 60 * Math.PI * 2 * dt;
    // physics-coupled audio: tone = teeth passing per second
    const toothHz = rpm / 60 * 12;
    S.hz = toothHz;
    R.hum('gears', { freq: 40 + toothHz, duty: 0.3, gain: t < S.full.start ? 0.12 : 0.3, noise: 0.1 });
    if (R.crossed(S.peelT)) R.sfx('whoosh');
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t;
    R.theme.header ? R.theme.header(R, '{{TITLE}}') : R.title('{{TITLE}}');
    R.world(() => {
      R.gear(110, 190, 24, 12, S.angle, P.cyan, { hole: 5, shadow: true });
      R.gear(152, 190, 18, 9, -S.angle * 12 / 9 + 0.2, P.gold, { hole: 4, shadow: true });
      R.peel((t - S.peelT) / 0.9, () => {
        R.box(78, 150, 114, 80, { fill: P.panel2, border: P.dim });
        R.text('CASING', 135, 186, { color: P.mid, align: 'center' });
      }, { mode: 'wipe', bbox: [78, 150, 114, 80] });
      if (t > S.zoom.start + 1.2) {
        R.label('DRIVE GEAR', 110, 170, { sub: '12 TEETH', color: P.cyan, appear: (t - S.zoom.start - 1.2) / 0.6 });
        R.force(132, 190, -Math.PI / 2, 14, P.coral, { pulse: true });
      }
    });
    R.telemetry(R.FOOTER.x, R.FOOTER.y, R.FOOTER.w, [
      { label: 'RPM', value: S.rpm, color: P.cyan },
      { label: 'TONE', value: S.hz + 40, unit: 'HZ', color: P.gold }
    ]);
  }
});
