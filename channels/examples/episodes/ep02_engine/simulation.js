/* ep02 — How an Engine Fires (v2 feature demo)
 * Bill of materials (7 interacting parts): engine block casing, cylinder bore, piston + rings,
 * connecting rod, crankshaft + counterweight, intake/exhaust valves (+springs), spark plug.
 *
 * Choreography:
 *   hook      full view, block casing wipes away on the word "peel"
 *   zoom      camera 2x into the chamber; crank angle is keyframed to the words
 *             "intake" / "rises" / "fires" / "exhaust" so every stroke lands on its narration
 *   failure   spark fires 40° early from the word "early" -> knock, PSI spike, red force arrows
 *   fullspeed zoom out, RPM ramps; continuous engine tone (Hz = 40 + RPM/20) drives HUD + scope
 *
 * Physics-coupled audio: R.hum('engine') every frame with freq = 40 + RPM/20, gain pulsing on
 * each power stroke; discrete 'thud' on every spark, 'click' on valve events.
 */
const ENG = { cx: 135, cy: 250, r: 18, L: 52, boreL: 114, boreR: 156, head: 132, SLOWMO: 20 };

Retro.defineSim({
  seed: 11,
  defaultBeats: [{ id: 'hook', dur: 6.5 }, { id: 'zoom', dur: 15 }, { id: 'failure', dur: 9.5 }, { id: 'fullspeed', dur: 8.5 }],

  setup(R) {
    const S = R.state;
    const H = R.beat('hook'), Z = R.beat('zoom'), F = R.beat('failure'), U = R.beat('fullspeed');
    S.H = H; S.Z = Z; S.F = F; S.U = U;
    Camera.setView(R.SAFE.x, R.SAFE.y + 15, R.SAFE.w, R.SAFE.h - 15);
    const home = { x: 135, y: Camera.view.y + Camera.view.h / 2 };

    // ---- word-locked timing
    S.peelT = R.wordAt('peel', 'hook', H.start + H.dur * 0.35);
    S.zoomT = R.wordAt('zoom', 'zoom', Z.start);
    const tIn = Math.max(S.zoomT + 0.6, R.wordAt('intake', 'zoom', Z.start + Z.dur * 0.12));
    const tRise = Math.max(tIn + 1.0, R.wordAt('rises', 'zoom', Z.start + Z.dur * 0.38));
    const tFire = Math.max(tRise + 1.0, R.wordAt('fires', 'zoom', Z.start + Z.dur * 0.6));
    const tExh = Math.max(tFire + 1.0, R.wordAt('exhaust', 'zoom', Z.start + Z.dur * 0.82));
    const tEnd = Math.max(tExh + 1.0, Z.end - 0.05);
    S.earlyT = R.wordAt('early', 'failure', F.start + F.dur * 0.3);
    S.knockWordT = R.wordAt('knock', 'failure', F.start + F.dur * 0.7);

    // ---- crank angle (degrees, 720 = one 4-stroke cycle) as a closed-form function of time
    const n = Math.max(1, Math.round(tIn * 300 / 720));
    const w1 = 720 * n / tIn;                      // hook: constant speed, lands exactly on a cycle start
    const kf = [[tIn, 720 * n], [tRise, 720 * n + 180], [tFire, 720 * n + 360], [tExh, 720 * n + 540], [tEnd, 720 * n + 720]];
    const w3 = 330;                                 // failure: steady slow-mo
    const w4 = 1150, Tr = Math.max(1.5, U.dur * 0.55);   // fullspeed ramp
    const base3 = 720 * (n + 1), base4 = base3 + (U.start - tEnd) * w3;
    S.theta = (t) => {
      if (t < tIn) return w1 * t;
      if (t < tEnd) {
        for (let i = 0; i + 1 < kf.length; i++) if (t < kf[i + 1][0]) return R.lerp(kf[i][1], kf[i + 1][1], (t - kf[i][0]) / (kf[i + 1][0] - kf[i][0]));
      }
      if (t < U.start) return base3 + (t - tEnd) * w3;
      const tau = t - U.start, dw = w4 - w3;
      return base4 + w3 * tau + (tau < Tr ? dw * tau * tau * tau / (3 * Tr * Tr) : dw * (Tr / 3 + (tau - Tr)));
    };
    S.sparkAngle = (t) => (t >= S.earlyT && t < U.start) ? 320 : 360;

    // ---- camera choreography (keyframes = pure function of time)
    Camera.track([
      { t: 0, x: home.x, y: home.y, zoom: 1 },
      { t: S.zoomT, x: home.x, y: home.y, zoom: 1 },
      { t: S.zoomT + 1.1, x: 135, y: 152, zoom: 2.0 },
      { t: F.start, x: 135, y: 152, zoom: 2.0 },
      { t: F.start + 1.0, x: 135, y: 180, zoom: 1.55 },
      { t: U.start, x: 135, y: 180, zoom: 1.55 },
      { t: U.start + 1.2, x: home.x, y: home.y, zoom: 1 }
    ]);
    S.prev = S.theta(0);
    S.lastSpark = -10; S.lastSparkDeg = -1e9; S.knockT = -10; S.knocks = 0;
  },

  update(R, dt) {
    const S = R.state, P = R.PAL, t = R.t;
    const th = S.theta(t), prev = S.prev;
    S.th = th; S.cyc = ((th % 720) + 720) % 720;
    S.w = Math.max(0, (th - prev) / dt);
    S.rpm = R.tween('rpm', S.w / 360 * 60 * ENG.SLOWMO, 0.12);
    S.tone = 40 + S.rpm / 20;
    const crossed = (a) => Math.floor((th - a) / 720) > Math.floor((prev - a) / 720);
    const sa = S.sparkAngle(t);

    // valve events
    if (t < S.U.start + 1) {
      if (crossed(0) || crossed(540)) R.sfx('click', 0, { vol: 0.7, pan: crossed(0) ? -0.4 : 0.4 });
    }
    if (crossed(540) && (t < S.peelT + 1 || t > S.U.start)) R.burst(208, 121, 6, [P.mid, P.dim], 0.8, { gravity: -0.02, lift: 0.2 });
    // spark
    if (crossed(sa)) {
      S.lastSpark = t; S.lastSparkDeg = Math.floor((th - sa) / 720) * 720 + sa; S.sparkAt = sa;
      if (S.w < 900) R.sfx('thud', Math.round(S.w / 120), { vol: 0.9 });
      R.sfx('click', 12, { vol: 0.6 });
      if (t < S.peelT) R.shake(1, 5);
    }
    // knock: early spark + piston still rising -> pressure spike just before TDC
    if (sa < 360 && crossed(352)) {
      S.knockT = t; S.knocks++;
      R.sfx('explosion', 3, { vol: 0.7 }); R.sfx('alert', 0, { vol: 0.8 });
      R.shake(4, 14); R.flash(P.coral, 8);
    }
    if (R.crossed(S.peelT)) R.sfx('whoosh');
    if (R.crossed(S.zoomT)) R.sfx('blip', 7);
    if (R.crossed(S.U.start)) R.sfx('powerup');
    if (R.crossed(S.U.end - 1.4)) R.sfx('level', 0, { vol: 0.8 });

    // continuous physics-coupled engine tone: Hz = 40 + RPM/20, gain pulses on each power stroke
    const since = th - S.lastSparkDeg;
    const pulse = since >= 0 && since < 720 ? Math.exp(-since / 90) : 0;
    const base = t < S.peelT ? 0.07 : t < S.U.start ? 0.1 : R.lerp(0.1, 0.32, R.clamp((t - S.U.start) / 2, 0, 1));
    R.hum('engine', { freq: S.tone, duty: 0.22 + 0.18 * pulse, gain: base * (0.55 + 0.45 * pulse), noise: 0.12 + 0.25 * pulse });
    S.prev = th;
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, SAFE = R.SAFE;
    const k = geom(S);

    // ---- header: title in the hook, then the 4-stroke indicator
    if (t < S.zoomT) R.theme.header ? R.theme.header(R, 'HOW AN ENGINE FIRES') : R.title('HOW AN ENGINE FIRES');
    else strokeBar(R, S);
    if (t >= S.zoomT + 0.5) R.reserve(R.tag('SLOW-MO ×' + ENG.SLOWMO, SAFE.x + SAFE.w - 2, SAFE.y + 18, P.violet, { align: 'right', textColor: P.bg }));

    R.world(() => {
      drawPipesAndCase(R, S, k);
      drawChamber(R, S, k);
      drawMovingParts(R, S, k);
      drawHeadAndValves(R, S, k);
      R.peel((t - S.peelT) / 0.9, () => drawCasing(R, S), { mode: 'wipe', dir: 'right', bbox: [88, 88, 94, 210] });
      annotate(R, S, k);
    });

    // ---- HUD
    const F = R.FOOTER;
    R.telemetry(F.x, F.y, 110, [
      { label: 'RPM', value: S.rpm, color: P.cyan },
      { label: 'TONE', value: S.tone, unit: 'HZ', color: P.gold }
    ]);
    const hot = k.psi > 1300;
    R.telemetry(F.x + 116, F.y, 110, [
      { label: 'PSI', value: k.psi, color: hot ? P.coral : P.emerald },
      { label: 'SPARK', value: (S.sparkAngle(t) === 360 ? 'ON TIME' : '40° EARLY'), color: S.sparkAngle(t) === 360 ? P.emerald : P.coral }
    ]);
    if (t >= S.U.start + 1.2) {
      const a = R.clamp((t - S.U.start - 1.2) / 0.4, 0, 1);
      if (a > 0) {
        R.gauge(56, 300, 26, S.rpm / 5000, { label: 'RPM', value: R.fmt(S.rpm), danger: 0.8, color: P.cyan });
        R.scope(178, 268, 68, 34, (ph) => ph < (0.22 + 0.1) ? 1 : -1, { cycles: S.tone / 28, phase: (t * S.tone / 28) % 1, color: P.gold });
        R.text(R.fmt(S.tone) + ' HZ', 212, 258, { color: P.gold, align: 'center' });
      }
    }
  }
});

// ==================================================================== geometry & physics
function geom(S) {
  const deg = S.th || 0, a = deg * Math.PI / 180, cyc = S.cyc || 0;
  const px = ENG.cx + ENG.r * Math.sin(a), py = ENG.cy - ENG.r * Math.cos(a);
  const pinY = ENG.cy - ENG.r * Math.cos(a) - Math.sqrt(ENG.L * ENG.L - Math.pow(ENG.r * Math.sin(a), 2));
  const top = pinY - 14;
  const hT = (ENG.cy - ENG.r - ENG.L) - 14 - ENG.head, hB = (ENG.cy + ENG.r - ENG.L) - 14 - ENG.head;
  const vol = (yTop) => 1 + 9 * ((yTop - ENG.head) - hT) / (hB - hT);   // virtual 10:1 compression ratio
  const v = vol(top);
  const sa = S.sparkAt || 360;
  let psi = 13, flame = 0, knock = false;
  if (cyc >= 180 && cyc < 540) {
    psi = 14.7 * Math.pow(10 / v, 1.3);
    const sinceSpark = cyc - sa;
    if (S.lastSparkDeg > -1e8 && deg - S.lastSparkDeg >= 0 && deg - S.lastSparkDeg < 220) {
      flame = R_clamp((deg - S.lastSparkDeg) / 30, 0, 1);
      psi *= 1 + 2.4 * flame;
      if (sa < 360 && cyc < 395) { knock = cyc > 340; psi *= knock ? 1.6 : 1.15; }
    }
    void sinceSpark;
  } else if (cyc >= 540) psi = 16;
  const intakeLift = cyc < 180 ? 6 * Math.sin(Math.PI * cyc / 180) : 0;
  const exhaustLift = cyc >= 540 ? 6 * Math.sin(Math.PI * (cyc - 540) / 180) : 0;
  const stroke = Math.floor(cyc / 180);   // 0 intake, 1 compression, 2 power, 3 exhaust
  return { a, px, py, pinY, top, psi, flame, knock, intakeLift, exhaustLift, stroke, cyc };
}
function R_clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ==================================================================== drawing
function strokeBar(R, S) {
  const P = R.PAL, SAFE = R.SAFE, names = ['INTAKE', 'COMPRESS', 'POWER', 'EXHAUST'];
  const colors = [P.cyan, P.violet, P.gold, P.mid];
  const k = Math.floor((S.cyc || 0) / 180), w = Math.floor(SAFE.w / 4);
  names.forEach((n, i) => {
    const on = i === k, x = SAFE.x + i * w;
    R.rect(x + 1, SAFE.y, w - 2, 12, on ? colors[i] : P.panel);
    R.text(n, x + w / 2, SAFE.y + 3, { color: on ? P.bg : P.dim, align: 'center', shadow: false });
  });
}

function drawPipesAndCase(R, S, k) {
  const P = R.PAL, t = R.t;
  // intake (left) and exhaust (right) runners
  R.rect(58, 115, 44, 12, P.dim); R.rect(58, 117, 44, 8, P.black);
  R.rect(168, 115, 44, 12, P.dim); R.rect(168, 117, 44, 8, P.black);
  if (k.intakeLift > 0.5) R.flow([[60, 121], [102, 121], [116, 127], [124, 133]], P.cyan, { speed: 30, spacing: 8 });
  if (k.exhaustLift > 0.5) R.flow([[146, 133], [154, 127], [168, 121], [210, 121]], P.orange, { speed: 30, spacing: 8 });
  // crankcase
  R.circle(ENG.cx, ENG.cy, 38, P.panel2, { outline: P.black, outlineW: 2, shadow: true });
  R.ring(ENG.cx, ENG.cy, 34, 38, P.dim);
  void t;
}

function drawChamber(R, S, k) {
  const P = R.PAL;
  R.rect(ENG.boreL, ENG.head, ENG.boreR - ENG.boreL, 104, P.black);
  const h = k.top - ENG.head;
  const gas = [P.cyanDk, P.violet, P.orange, P.dim][k.stroke];
  if (k.stroke === 2 || (k.flame > 0 && k.stroke === 1)) {
    R.rect(ENG.boreL, ENG.head, ENG.boreR - ENG.boreL, h, k.knock ? P.coralDk : P.goldDk);
    const rad = 4 + 20 * k.flame * (k.stroke === 2 ? 1 : 0.8);
    R.circle(135, ENG.head + 2, rad, k.knock ? P.coral : P.orange);
    R.circle(135, ENG.head + 2, rad * 0.55, k.knock ? P.white : P.gold);
  } else {
    R.dither(ENG.boreL, ENG.head, ENG.boreR - ENG.boreL, h, gas, Math.floor(R.t * 8) & 1);
    if (k.stroke === 1) R.dither(ENG.boreL, ENG.head, ENG.boreR - ENG.boreL, h, P.cyanDk, 1);
  }
}

function drawMovingParts(R, S, k) {
  const P = R.PAL;
  // piston + rings + wrist pin
  R.rect(ENG.boreL + 1, k.top, ENG.boreR - ENG.boreL - 2, 26, k.knock ? P.coral : P.text);
  R.rect(ENG.boreL + 1, k.top, ENG.boreR - ENG.boreL - 2, 2, P.white);
  R.rect(ENG.boreL + 1, k.top + 4, ENG.boreR - ENG.boreL - 2, 1, P.dim);
  R.rect(ENG.boreL + 1, k.top + 7, ENG.boreR - ENG.boreL - 2, 1, P.dim);
  // connecting rod
  R.link(135, k.pinY, k.px, k.py, 7, k.knock ? P.coral : P.mid, { outline: P.black, outlineW: 1 });
  R.circle(135, k.pinY, 3, P.dim);
  // crankshaft: counterweight opposite the crankpin
  const cw = [[ENG.cx, ENG.cy]];
  for (let i = 0; i <= 12; i++) { const a = k.a + Math.PI / 2 + Math.PI * i / 12; cw.push([ENG.cx + Math.sin(a) * 15, ENG.cy - Math.cos(a) * 15]); }
  R.poly(cw, P.gold, { outline: P.black, outlineW: 1, shadow: true });
  R.link(ENG.cx, ENG.cy, k.px, k.py, 9, P.gold, { outline: P.black, outlineW: 1 });
  R.circle(k.px, k.py, 4, P.white, { outline: P.black, outlineW: 1 });
  R.circle(ENG.cx, ENG.cy, 4, P.dim, { outline: P.black, outlineW: 1 });
}

function drawHeadAndValves(R, S, k) {
  const P = R.PAL;
  // cylinder walls (cut surfaces hatched)
  for (const x of [106, ENG.boreR]) { R.rect(x, ENG.head, 8, 104, P.panel2); R.hatch(x, ENG.head, 8, 104, P.dim, 3); }
  // head
  R.rect(100, 110, 70, 22, P.panel2); R.hatch(100, 110, 70, 22, P.dim, 3);
  R.border(100, 110, 70, 22, P.black);
  R.poly([[100, 115], [117, 122], [130, 132], [117, 132], [100, 126]], P.black);
  R.poly([[170, 115], [153, 122], [140, 132], [153, 132], [170, 126]], P.black);
  // valves: stem + spring + head
  const valve = (x, lift, c) => {
    R.line(x, 92, x, ENG.head + lift, P.text, 2);
    R.spring(x, 94 + lift * 0.3, x, 108, 4, 8, P.mid);
    R.rect(x - 5, 90 + lift * 0.3, 10, 3, P.dim);
    R.rotRect(x, ENG.head + lift, 12, 3, 0, c, { outline: P.black, outlineW: 1 });
  };
  valve(124, k.intakeLift, P.cyan);
  valve(146, k.exhaustLift, P.orange);
  // spark plug
  R.rect(132, 92, 6, 14, P.white); R.rect(130, 104, 10, 5, P.mid); R.line(135, 109, 135, ENG.head + 1, P.text, 1);
  const sinceSpark = R.t - S.lastSpark;
  if (sinceSpark >= 0 && sinceSpark < 0.12) {
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + R.t * 9; R.line(135, ENG.head + 2, 135 + Math.cos(a) * 5, ENG.head + 2 + Math.sin(a) * 5, i % 2 ? R.PAL.white : R.PAL.gold); }
  }
}

function drawCasing(R) {
  const P = R.PAL;
  R.box(88, 88, 94, 210, { fill: P.dim, border: P.black, shadow: true });
  for (let y = 100; y < 236; y += 9) R.rect(92, y, 86, 3, P.mid);      // cooling fins
  for (const [x, y] of [[96, 284], [174, 284], [96, 246], [174, 246]]) R.circle(x, y, 2, P.panel);
  R.text('1-CYL', 135, 258, { color: P.text, align: 'center' });
  R.text('ENGINE', 135, 268, { color: P.text, align: 'center' });
}

function annotate(R, S, k) {
  const P = R.PAL, t = R.t;
  const zoomed = t >= S.zoomT + 1.1 && t < S.F.start;
  if (zoomed) {
    const ap = (t - S.zoomT - 1.1) / 0.6;
    R.label('INTAKE', 122, ENG.head + k.intakeLift, { sub: 'VALVE', color: P.cyan, side: 'left', appear: ap });
    R.label('EXHAUST', 148, ENG.head + k.exhaustLift, { sub: 'VALVE', color: P.orange, side: 'right', appear: ap - 0.3 });
    R.label('SPARK', 138, 100, { sub: 'PLUG', color: P.gold, side: 'right', appear: ap - 0.6 });
    R.label('PISTON', ENG.boreL + 2, k.top + 10, { sub: '+ RINGS', color: P.text, side: 'left', appear: ap - 0.9 });
  }
  // gas-pressure arrows on the piston crown (length ∝ PSI) + piston motion arrow
  if (t >= S.peelT + 0.9 && k.psi > 60) {
    const L = R_clamp(6 + k.psi / 70, 6, 26), c = k.knock ? P.coral : P.gold;
    for (const x of [122, 135, 148]) R.force(x, k.top - L / (R.camera.zoom) - 2, Math.PI / 2, L, c, { pulse: k.knock });
  }
  if (t >= S.F.start && t < S.U.start) {
    const rising = k.cyc % 360 > 180;
    R.force(162, k.top + 12, rising ? -Math.PI / 2 : Math.PI / 2, 12, P.cyan, { label: rising ? 'UP' : 'DOWN' });
    if (t - S.knockT < 1.1) {
      R.callout('KNOCK!', 135, ENG.head + 10, { color: P.coral, dir: 'down', appear: (t - S.knockT) / 0.15, scale: 2 });
      R.label('CON ROD', 140, (k.pinY + k.py) / 2, { sub: 'SHOCK LOAD', color: P.coral, side: 'right', appear: (t - S.knockT) / 0.3 });
    }
  }
}
