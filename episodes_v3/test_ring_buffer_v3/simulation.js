/* test_ring_buffer_v3 — V3 Visual-First pipeline test (no narration).
 * Exercises: hook banner, impact micro-text (badge / warn / ok / formula) with pointers, payoff stamp,
 * camera zoom, frame-locked SFX, R.onBeat() mechanical steps on the groove grid, R.pulse() accents,
 * and a continuous filtered "pressure" voice (R.synth with cutoff) tied to buffer occupancy.
 */
const RING = { cx: 135, cy: 240, r: 64, N: 8 };
const slotPos = (i) => { const a = -Math.PI / 2 + i * Math.PI / 4; return { x: RING.cx + Math.cos(a) * RING.r, y: RING.cy + Math.sin(a) * RING.r, a }; };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

Retro.defineSim({
  seed: 3,
  defaultBeats: [{ id: 'hook', dur: 3.5 }, { id: 'loop', dur: 9.5 }, { id: 'full', dur: 8 }, { id: 'payoff', dur: 7 }],

  setup(R) {
    const S = R.state;
    S.buf = new Array(8).fill(null);
    // ring starts with 6 items in slots 7,0,1,2,3,4 (tail=7, head=5) so the first dequeue WRAPS
    [7, 0, 1, 2, 3, 4].forEach((s, k) => { S.buf[s] = LETTERS[k]; });
    S.head = 5; S.tail = 7; S.count = 6; S.headAbs = 5; S.tailAbs = -1; S.next = 6;
    S.flyers = []; S.wraps = []; S.fullT = -1; S.lastBlocked = -1;
    S.B = { hook: R.beat('hook'), loop: R.beat('loop'), full: R.beat('full'), pay: R.beat('payoff') };
    S.dequeueT = 1.0;
    S.stampT = S.B.pay.start + 3.2;
    const b = S.B;
    // world is clipped to the upper part of the UI-safe box; HUD strip below it
    Camera.setView(R.SAFE.x, R.SAFE.y, R.SAFE.w, 255);
    // ring + slot labels + pointers occupy roughly this world box; fit:[] lets the engine pick the
    // largest zoom that keeps it inside the safe zone (fitBoundsToSafeZone)
    const RING_BOX = [RING.cx - 100, RING.cy - 100, 200, 200];
    const FOCUS_6701 = [40, 145, 168, 105];          // slots [6,7,0,1] incl. labels + HEAD pointer
    Camera.track([
      { t: 0, x: 135, y: 181, zoom: 0.8 },                                 // hook: ring low, queue strip on top
      { t: b.loop.start + 0.1, x: 135, y: 181, zoom: 0.8 },
      { t: b.loop.start + 1.0, fit: FOCUS_6701, zoom: 1.7 },                // zoom into [6,7,0,1], clamped to safe zone
      { t: b.full.start, fit: FOCUS_6701, zoom: 1.7 },
      { t: b.full.start + 0.8, fit: RING_BOX },                             // whole ring while it fills
      { t: b.pay.start, fit: RING_BOX },
      { t: b.pay.start + 0.8, x: 135, y: 160, zoom: 0.7 }                   // ring low, payoff stamp on top
    ]);
  },

  update(R) {
    const S = R.state, t = R.t, P = R.PAL, b = S.B;
    const write = () => {
      if (S.count >= 8) return false;
      const slot = S.head, v = LETTERS[S.next++ % 26];
      S.buf[slot] = v; S.count++;
      S.flyers.push({ kind: 'in', slot, v, t0: t, dur: 0.22 });
      S.head = (S.head + 1) % 8; S.headAbs++;
      R.sfx('pop', slot * 2, { pan: -0.3, vol: 0.8 });
      if (S.head === 0) { S.wraps.push(t); R.sfx('wrap'); R.pulse('snare', { accent: 0.6 }); }
      return true;
    };
    const read = () => {
      if (S.count <= 0) return false;
      const slot = S.tail, v = S.buf[slot];
      S.buf[slot] = null; S.count--;
      S.flyers.push({ kind: 'out', slot, v, t0: t, dur: 0.3 });
      S.tail = (S.tail + 1) % 8; S.tailAbs++;
      R.sfx('hop', 12 - slot, { pan: 0.3, vol: 0.8 });
      return true;
    };

    // HOOK: one dequeue — the ring just hops TAIL 7 -> 0 (wrap)
    if (R.crossed(S.dequeueT)) { read(); R.sfx('wrap', 5); }
    for (let k = 1; k <= 6; k++) if (R.crossed(S.dequeueT + 0.12 + k * 0.12)) R.sfx('tick', k * 2, { pan: -0.5 });
    if (R.crossed(S.dequeueT + 0.95)) R.sfx('evict', 0, { vol: 0.7 });
    if (R.crossed(2.0)) R.sfx('hit', 7);

    // LOOP: producer on the beat, consumer on the off-beat (both on the groove's frame grid)
    if (t >= b.loop.start + 1.0 && t < b.full.start) {
      if (R.onBeat(1)) write();
      else if (R.onBeat(2)) read();
    }
    // FULL: producer bursts on every 16th, consumer stalls -> fills
    if (t >= b.full.start && t < b.pay.start) {
      if (R.onBeat(4)) {
        if (!write() && R.onBeat(1)) { R.sfx('error', 0, { vol: 0.7 }); S.lastBlocked = t; }
      }
      if (S.count === 8 && S.fullT < 0) { S.fullT = t; R.sfx('warn'); R.pulse('kick', { accent: 1 }); R.shake(3, 12); R.flash(P.coral, 6); }
    }
    // PAYOFF: consumer catches up (2 reads per beat) until balanced, then 1:1
    if (t >= b.pay.start && t < b.pay.end - 1.0) {
      if (R.onBeat(1)) write();
      if (R.onBeat(2) && (S.count > 4 || !R.onBeat(1))) read();
    }
    // continuous pressure voice: pitch + filter cutoff follow occupancy (only while filling)
    if (t >= b.full.start && t < b.pay.start + 1.0) {
      const occ = S.count / 8, rel = t >= b.pay.start ? 1 - (t - b.pay.start) : 1;
      R.synth('pressure', { freq: 55 + occ * 110, duty: 0.3, gain: (0.08 + occ * 0.22) * rel, noise: 0.05, cutoff: 250 + occ * occ * 3500, res: 0.55, wave: 'saw' });
    }
    S.flyers = S.flyers.filter(f => t - f.t0 < f.dur + 0.05);
  },

  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, b = S.B, SAFE = R.SAFE;
    if (!R.theme.background) R.grid(0, 0, R.W, R.H, 15, P.grid);

    // ---- HOOK: linear queue strip (screen space) — dequeue + 6-item left-shift ripple
    if (t < b.hook.end) drawLinearStrip(R, S);
    R.hookBanner('QUEUE VS RING', { t0: 0, dur: 3.3, sub: 'DEQUEUE ONE ITEM', color: P.gold });

    // ---- RING (world space, camera-driven)
    R.world(() => {
      R.circle(RING.cx, RING.cy, RING.r + 14, P.panel, { outline: P.black, outlineW: 1 });
      R.circle(RING.cx, RING.cy, RING.r - 14, P.bg);
      const full = S.count === 8 && t >= b.full.start && t < b.pay.start;
      for (let i = 0; i < 8; i++) {
        const p = slotPos(i), v = S.buf[i];
        const flash = full && Math.floor(t * 8) % 2 === 0;
        const fill = v ? (flash ? P.coral : P.cyanDk) : P.panel2, border = v ? (full ? P.coral : P.cyan) : P.dim;
        R.box(p.x - 12, p.y - 8, 24, 16, { fill, border });
        if (v) R.text(v, p.x, p.y - 3, { color: P.white, align: 'center', shadow: false });
        const lp = { x: RING.cx + Math.cos(p.a) * (RING.r + 22), y: RING.cy + Math.sin(p.a) * (RING.r + 22) };
        R.text('[' + i + ']', lp.x, lp.y - 3, { color: P.mid, align: 'center', shadow: false });
      }
      // pointers: HEAD outside (gold), TAIL inside (cyan); angles tween so hops glide
      const hA = -Math.PI / 2 + R.tween('hA', S.headAbs, 0.35) * Math.PI / 4;
      const tA = -Math.PI / 2 + R.tween('tA', S.tailAbs, 0.35) * Math.PI / 4;
      pointer(R, hA, RING.r + 36, RING.r + 13, P.gold, 'HEAD');
      pointer(R, tA, RING.r - 34, RING.r - 13, P.cyan, 'TAIL');
      // packets in flight
      for (const f of S.flyers) {
        const k = R.clamp((t - f.t0) / f.dur, 0, 1), p = slotPos(f.slot);
        // producer enters / consumer exits at the edges of the CURRENT camera view (always inside the safe zone)
        const V = Camera.view, edgeL = R.toWorld(V.x + 12, V.y + 34), edgeR = R.toWorld(V.x + V.w - 12, V.y + 34);
        const from = f.kind === 'in' ? edgeL : p, to = f.kind === 'in' ? p : edgeR;
        const e = R.ease.inOut(k), x = R.lerp(from.x, to.x, e), y = R.lerp(from.y, to.y, e) - Math.sin(Math.PI * k) * 14;
        R.box(x - 7, y - 6, 14, 12, { fill: f.kind === 'in' ? P.gold : P.emerald, border: P.black });
        R.text(f.v, x, y - 3, { color: P.bg, align: 'center', shadow: false });
      }
      R.text('RING BUFFER', RING.cx, RING.cy - 8, { color: P.text, align: 'center' });
      R.text(S.count + '/8', RING.cx, RING.cy + 3, { color: S.count === 8 ? P.coral : P.emerald, align: 'center', scale: 1 });

      // ---- micro-text anchored to world positions
      const tailP = slotPos(0);
      R.micro('WRAP MOD 8', tailP.x, tailP.y - 9, { t0: S.dequeueT + 0.05, dur: 2.2, style: 'badge', color: P.cyan, at: [48, -12] });
      R.micro('ZERO SHIFTING', RING.cx, RING.cy, { t0: 2.0, dur: 1.4, style: 'ok', at: [0, 96], pointer: false, size: 2 });
      for (const wt of S.wraps) if (wt >= b.loop.start) R.micro('MODULO WRAP', slotPos(0).x, slotPos(0).y - 9, { t0: wt, dur: 1.3, style: 'badge' });
      if (S.fullT > 0) {
        const hp = slotPos(S.head);
        R.micro('FULL! OVERWRITE RISK', hp.x, hp.y - 9, { t0: S.fullT, dur: b.pay.start - S.fullT, style: 'warn', priority: 2 });
      }
    });

    // ---- formulas & HUD (screen space)
    const SCX = SAFE.x + SAFE.w / 2, FY = SAFE.y + 255 + 8;
    R.formula('HEAD=(HEAD+1)%8', SCX, FY, { t0: b.loop.start + 2.0, dur: b.full.start - b.loop.start - 2.2, at: [0, 0] });
    if (S.fullT > 0) R.formula('HEAD == TAIL ?', SCX, FY, { t0: S.fullT + 0.6, dur: b.pay.start - S.fullT - 0.6, at: [0, 0] });
    if (t >= b.loop.start + 1.0) {
      const rows = t < b.pay.start
        ? [{ label: 'COUNT', value: S.count + ' / 8', color: S.count === 8 ? P.coral : P.emerald }, { label: 'SHIFT_COST', value: 0, color: P.cyan }]
        : [{ label: 'SHIFT_COST', value: 0, color: P.emerald }, { label: 'STEP', value: 'O(1)', color: P.gold }, { label: 'RAM', value: '8 SLOTS FIXED', color: P.cyan }];
      R.telemetry(SAFE.x, SAFE.y + SAFE.h - 6 - rows.length * 10 - 6, SAFE.w, rows);
      R.reserve(SAFE.x, SAFE.y + SAFE.h - 6 - rows.length * 10 - 6, SAFE.w, rows.length * 10 + 6);
    }
    R.payoffStamp('FIXED RAM.\nO(1) FLOW.', { t0: S.stampT, color: P.emerald, y: SAFE.y + 70 });
  }
});

function pointer(R, ang, r0, r1, color, label) {
  const x0 = RING.cx + Math.cos(ang) * r0, y0 = RING.cy + Math.sin(ang) * r0;
  const x1 = RING.cx + Math.cos(ang) * r1, y1 = RING.cy + Math.sin(ang) * r1;
  R.arrow(x0, y0, x1, y1, color, { thick: 1, head: 4 });
  const lx = RING.cx + Math.cos(ang) * (r0 + (r0 > r1 ? 8 : -8)), ly = RING.cy + Math.sin(ang) * (r0 + (r0 > r1 ? 8 : -8));
  const sp = R.toScreen(lx, ly), V = Camera.view, hw = R.textWidth(label) / 2 + 4;
  const tx = R.clamp(sp.x, V.x + hw + 1, V.x + V.w - hw - 1), ty = R.clamp(sp.y - 6, V.y + 1, V.y + V.h - 13);  // keep tag inside the view
  R.reserve(R.tag(label, tx, ty, color, { align: 'center' }));  // micro-text avoids pointer tags
}

function drawLinearStrip(R, S) {
  const P = R.PAL, t = R.t, step = 25, x0 = Math.round(R.SAFE.x + (R.SAFE.w - (8 * step - 4)) / 2), y = 124, dt = t - S.dequeueT;
  R.tag('LINEAR QUEUE', x0, y - 14, P.coral, { textColor: P.white });
  for (let i = 0; i < 8; i++) R.box(x0 + i * step, y, 21, 18, { fill: P.panel2, border: P.dim });
  const items = 'ABCDEFG'.split('');
  let shifts = 0;
  items.forEach((v, i) => {
    let x = x0 + i * step, yy = y;
    if (i === 0 && dt > 0) { yy = y - Math.min(30, dt * 90); if (dt > 0.35) return; }
    if (i > 0) {
      const k = R.clamp((dt - 0.12 - i * 0.12) / 0.12, 0, 1);
      if (k > 0) shifts++;
      x -= step * R.ease.inOut(k);
    }
    R.box(x, yy, 21, 18, { fill: P.coralDk, border: P.coral });
    R.text(v, x + 10, yy + 6, { color: P.white, align: 'center', shadow: false });
  });
  R.text('SHIFTS: ' + shifts, x0 + 8 * step - 4, y + 24, { color: shifts ? P.coral : P.mid, align: 'right' });
  if (dt > 0.95) R.micro('SHIFT ×6', x0 + 3 * step, y + 18, { t0: S.dequeueT + 0.95, dur: 2.3, style: 'warn', at: [-34, 20] });
}
