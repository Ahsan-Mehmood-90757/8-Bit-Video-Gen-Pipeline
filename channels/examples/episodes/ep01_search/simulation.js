/* ep01 — Linear vs Binary Search
 * Top pane: linear search crawls box by box. Bottom pane: binary search halves the range.
 * Every visual milestone is scheduled from the beat times in build/timeline.js (written by
 * tts_and_captions.py), so the animation always lands on the narration.
 */
Retro.defineSim({
  seed: 7,
  // Used only for live preview before the TTS stage has produced build/timeline.js
  defaultBeats: [
    { id: 'hook', dur: 4.6 }, { id: 'setup', dur: 9.0 }, { id: 'escalation', dur: 7.6 },
    { id: 'climax', dur: 8.2 }, { id: 'takeaway', dur: 8.0 }
  ],

  setup(R) {
    const S = R.state, P = R.PAL;
    S.N = 64; S.COLS = 16; S.CELL = 11; S.PITCH = 13;
    S.values = Array.from({ length: S.N }, (_, i) => 2 + i * 3);

    // pick a target that binary search needs exactly 6 probes to find (log2 64 = 6)
    const probesFor = (idx) => {
      let lo = 0, hi = S.N - 1; const seq = [];
      while (lo <= hi) { const mid = (lo + hi) >> 1; seq.push({ lo, hi, mid }); if (mid === idx) break; if (mid < idx) lo = mid + 1; else hi = mid - 1; }
      return seq;
    };
    S.tIdx = 47;
    for (let i = 50; i >= 30; i--) if (probesFor(i).length === 6) { S.tIdx = i; break; }
    S.target = S.values[S.tIdx];
    S.probes = probesFor(S.tIdx);

    // ---- schedule, locked to narration: beat times + exact spoken-word times (R.wordAt)
    const su = R.beat('setup'), es = R.beat('escalation'), cl = R.beat('climax'), tk = R.beat('takeaway');
    const nP = S.probes.length;
    S.probeT = [R.wordAt('middle', 'setup', su.start + su.dur * 0.6)];             // "jumps to the middle"
    const pFound = R.wordAt('six', 'escalation', es.start + es.dur * 0.6);           // "binary needs SIX guesses"
    const p2 = es.start + 0.35, pLast = Math.max(p2 + 0.4 * (nP - 2), pFound - 0.7);
    for (let k = 1; k < nP - 1; k++) S.probeT.push(p2 + (k - 1) * (pLast - p2) / Math.max(1, nP - 3));
    S.probeT.push(Math.max(pFound, pLast + 0.4));
    S.elimDelay = 0.35;
    S.linStart = su.start + 0.4;
    S.linFoundT = R.wordAt('sixty-four', 'escalation', es.end - 0.6, 1);             // "linear might need SIXTY-FOUR"
    S.linInterval = (S.linFoundT - S.linStart) / S.tIdx;

    S.cl = cl; S.tk = tk;
    S.bigFoundT = R.wordAt('twenty', 'climax', cl.start + cl.dur * 0.7);            // "done in TWENTY"
    S.bigProbeT = [];
    const b0 = cl.start + 1.0;
    for (let k = 0; k < 20; k++) S.bigProbeT.push(b0 + k * (S.bigFoundT - b0) / 19);
    S.bigLinStart = cl.start + 0.4;
    S.bigLinEnd = R.wordAt('checks', 'climax', cl.start + cl.dur * 0.6, 0, 'end');  // "...a million CHECKS"
    S.bigTarget = 0.6337;
    S.tkRows = [0.15, 0.5, 0.85].map(d => tk.start + d);
    S.tkHalve = R.wordAt('halving', 'takeaway', tk.start + tk.dur * 0.2);
    S.tkDouble = R.wordAt('double', 'takeaway', tk.start + tk.dur * 0.4);
    S.tkSort = R.wordAt('sort', 'takeaway', tk.start + tk.dur * 0.75);

    // ---- pre-render the "million item" data walls (one-time ImageData, then drawImage per frame)
    const mkWall = (colors, seed) => {
      const c = document.createElement('canvas'); c.width = 207; c.height = 51;
      const g = c.getContext('2d'); const img = g.createImageData(207, 51);
      const rgb = colors.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
      let s = seed;
      for (let i = 0; i < 207 * 51; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const r = (s >> 8) % 100;
        const col = r < 55 ? rgb[0] : r < 85 ? rgb[1] : r < 97 ? rgb[2] : rgb[3];
        img.data.set([col[0], col[1], col[2], 255], i * 4);
      }
      g.putImageData(img, 0, 0);
      return c;
    };
    S.wallTop = mkWall([P.panel2, P.cyanDk, P.dim, P.cyan], 11);
    S.wallBot = mkWall([P.panel2, P.goldDk, P.dim, P.gold], 23);

    S.prevLin = 0; S.prevBig = 0;
  },

  // ------------------------------------------------------------------ logic + SFX triggers
  update(R) {
    const S = R.state, P = R.PAL, t = R.t;

    // hook: boxes pop in with a typewriter cascade
    for (let i = 0; i < S.N; i += 2) if (R.crossed(cellAppear(i))) R.sfx('type', Math.floor(i / 6), { vol: 0.8 });
    if (R.crossed(1.9)) R.sfx('blip', 7);

    // linear search (top)
    const lc = linCount(R);
    if (lc > S.prevLin) {
      if (lc === S.tIdx + 1) { R.sfx('coin', 0, { pan: -0.35 }); const c = cellPos(S, R.state.top, S.tIdx); R.burst(c.x + 5, c.y + 5, 14, [P.emerald, P.white]); }
      else R.sfx('tick', (lc % 8) * 2, { pan: -0.35, vol: 0.8 });
      S.prevLin = lc;
    }
    // binary search (bottom)
    S.probeT.forEach((pt, k) => {
      if (R.crossed(pt)) {
        if (k === S.probes.length - 1) {
          R.sfx('success', 0, { pan: 0.35 }); R.flash(P.emerald, 8);
          const c = cellPos(S, R.state.bottom, S.tIdx); R.burst(c.x + 5, c.y + 5, 26, [P.emerald, P.gold, P.white]);
        } else R.sfx('pulse', k * 2, { pan: 0.35 });
      }
      if (k < S.probes.length - 1 && R.crossed(pt + S.elimDelay)) R.sfx('click', 0, { pan: 0.35 });
    });

    // climax: a million items
    if (R.crossed(S.cl.start)) { R.sfx('powerup'); R.sfx('explosion', 0, { vol: 0.6 }); R.shake(3, 16); R.flash(P.white, 8); }
    S.bigProbeT.forEach((pt, k) => {
      if (R.crossed(pt)) {
        if (k === 19) { R.sfx('success', 5, { pan: 0.35 }); R.burst(R.state.bottom.cx || 135, R.state.bottom.y + 38, 24, [P.gold, P.emerald, P.white]); }
        else R.sfx('pulse', Math.floor(k * 0.8), { pan: 0.35, vol: 0.85 });
      }
    });
    const big = bigLin(R);
    if (big > 0 && big < 1e6 && R.every('bigtick', 4 / 60, S.bigLinStart)) R.sfx('tick', Math.floor(big / 1e6 * 14), { pan: -0.35, vol: 0.55 });
    if (R.crossed(S.bigLinEnd)) R.sfx('alert', 0, { pan: -0.35 });

    // takeaway
    const tk = S.tk;
    if (R.crossed(tk.start)) { R.sfx('whoosh'); R.flash(P.cyan, 6); }
    S.tkRows.forEach((rt, i) => { if (R.crossed(rt)) R.sfx('coin', i * 3); });
    if (R.crossed(S.tkHalve)) { R.sfx('level'); R.sfx('thud'); R.shake(4, 14); R.burst(135, 252, 30, [P.coral, P.gold, P.white], 2.2); }
    if (R.crossed(S.tkDouble)) R.sfx('blip', 12);
    if (R.crossed(S.tkSort)) R.sfx('powerup', 5, { vol: 0.6 });
    if (t >= S.tkSort && t < S.tkSort + 0.9 && R.every('typing', 3 / 60, S.tkSort)) R.sfx('type', 6, { vol: 0.6 });
  },

  // ------------------------------------------------------------------ drawing
  draw(R) {
    const S = R.state, P = R.PAL, t = R.t, SAFE = R.SAFE;


    if (t < S.tk.start) drawRace(R);
    else drawTakeaway(R);

    // footer telemetry: speed-up factor
    if (t >= S.probeT[S.probeT.length - 1]) {
      const F = R.FOOTER;
      R.box(F.x, F.y, F.w, F.h, { fill: P.panel, border: P.goldDk });
      // small race: linear checks so far / binary's 6; after the million-item race: 1,000,000 / 20
      const target = t >= S.bigFoundT ? 1e6 / 20 : linCount(R) / S.probes.length;
      const ratio = R.tween('speedup', target, t >= S.bigFoundT ? 0.07 : 0.3);
      R.text('SPEEDUP', F.x + 8, F.y + 8, { color: P.mid });
      R.text('BINARY VS LINEAR', F.x + 8, F.y + 19, { color: P.dim });
      R.text(R.fmt(ratio, { decimals: ratio < 100 ? 1 : 0 }) + '×', F.x + F.w - 8, F.y + 10, { color: P.gold, scale: 2, align: 'right' });
    }
  }
});

// ==================================================================== helpers
function cellAppear(i) { return 0.15 + i * 0.02; }

function cellPos(S, pane, i) {
  const gx = pane.x + Math.floor((pane.w - (S.COLS * S.PITCH - 2)) / 2);
  const gy = pane.y + 14;
  return { x: gx + (i % S.COLS) * S.PITCH, y: gy + Math.floor(i / S.COLS) * S.PITCH };
}

function linCount(R) {
  const S = R.state;
  if (R.t < S.linStart) return 0;
  return Math.min(S.tIdx + 1, Math.floor((R.t - S.linStart) / S.linInterval) + 1);
}
function bigLin(R) {
  const S = R.state;
  const p = R.clamp((R.t - S.bigLinStart) / (S.bigLinEnd - S.bigLinStart), 0, 1);
  return R.t < S.bigLinStart ? 0 : Math.round(1e6 * Math.pow(p, 2.2));
}
function bigBin(R) { return R.state.bigProbeT.filter(pt => R.t >= pt).length; }
function bigWindow(S, k) {
  let lo = 0, hi = 1;
  for (let i = 0; i < k; i++) { const mid = (lo + hi) / 2; if (S.bigTarget >= mid) lo = mid; else hi = mid; }
  let x0 = lo * 207, w = (hi - lo) * 207;
  if (w < 3) { const c = (x0 + w / 2); x0 = c - 1.5; w = 3; }
  return { x0, w, cx: 0, lo, hi };
}

function drawCell(R, x, y, fill, border, appear = 1) {
  const s = Math.round(11 * R.clamp(R.ease.outBack(R.clamp(appear, 0, 1)), 0, 1.25));
  if (s <= 0) return;
  const o = Math.round((11 - s) / 2);
  R.rect(x + o, y + o, s, s, border);
  if (s > 2) R.rect(x + o + 1, y + o + 1, s - 2, s - 2, fill);
  if (s > 4) R.px(x + o + 1, y + o + 1, 'rgba(255,255,255,0.25)');
}

function drawRace(R) {
  const S = R.state, P = R.PAL, t = R.t, SAFE = R.SAFE;
  const inClimax = t >= S.cl.start;
  const lay = R.split({ topLabel: 'LINEAR  O(N)', bottomLabel: 'BINARY  O(LOG N)', topColor: P.cyan, bottomColor: P.gold });
  S.top = lay.top; S.bottom = lay.bottom;

  // header
  R.text('SEARCH RACE', SAFE.x + 2, SAFE.y + 1, { color: P.white });
  if (!inClimax) {
    const show = R.clamp((t - 1.9) / 0.25, 0, 1);
    if (show > 0) {
      const blink = t < 4 && Math.floor(t * 4) % 2 === 0;
      R.tag('FIND ' + S.target, SAFE.x + SAFE.w, SAFE.y - 3 + Math.round((1 - R.ease.outBack(show)) * -6), blink ? P.white : P.gold, { align: 'right' });
    }
  } else {
    const k = R.clamp((t - S.cl.start) / 1.0, 0, 1);
    const items = Math.round(Math.exp(R.lerp(Math.log(64), Math.log(1e6), R.ease.out(k))));
    R.tag(R.fmt(items) + ' ITEMS', SAFE.x + SAFE.w, SAFE.y - 3, P.coral, { align: 'right', textColor: P.white });
  }

  if (!inClimax) { drawSmallLinear(R, lay.top); drawSmallBinary(R, lay.bottom); }
  else { drawBigLinear(R, lay.top); drawBigBinary(R, lay.bottom); }
}

function drawSmallLinear(R, pane) {
  const S = R.state, P = R.PAL, t = R.t;
  const lc = linCount(R), found = lc === S.tIdx + 1;
  for (let i = 0; i < S.N; i++) {
    const c = cellPos(S, pane, i);
    let fill = P.panel2, border = P.dim;
    if (i < lc - 1) { fill = P.cyanDk; border = '#0B3550'; }
    if (i === lc - 1) { fill = found ? P.emerald : P.white; border = found ? P.emeraldDk : P.cyan; }
    drawCell(R, c.x, c.y, fill, border, (t - cellAppear(i)) / 0.2);
  }
  if (lc > 0 && !found) { const c = cellPos(S, pane, lc - 1); R.rect(c.x + 3, c.y + 12, 5, 1, P.cyan); }
  if (found) { const c = cellPos(S, pane, S.tIdx); R.callout(`FOUND! ${S.tIdx + 1} CHECKS`, c.x + 5, c.y - 1, { color: P.emerald, dir: 'down', appear: (t - S.linFoundT) / 0.25 }); }
  const y = pane.y + 70;
  R.counter('lin', pane.x + 8, y, lc, { label: 'CHECKS', scale: 2, color: P.cyan, smooth: false });
  R.counter('linv', pane.x + pane.w - 8, y, lc ? S.values[lc - 1] : 0, { label: 'LOOKING AT', scale: 2, color: P.text, align: 'right', smooth: false, blink: false });
  R.bar(pane.x + 8, pane.y + 100, pane.w - 16, 10, lc / S.N, { color: P.cyan });
}

function binaryRange(R) {
  const S = R.state, t = R.t;
  let elim = 0;
  S.probeT.forEach((pt, k) => { if (t >= pt + S.elimDelay) elim = k + 1; });
  if (elim === 0) return { lo: 0, hi: S.N - 1 };
  if (elim >= S.probes.length) return { lo: S.tIdx, hi: S.tIdx };
  return { lo: S.probes[elim].lo, hi: S.probes[elim].hi };
}

function drawSmallBinary(R, pane) {
  const S = R.state, P = R.PAL, t = R.t;
  const rng = binaryRange(R);
  let cur = -1;
  S.probeT.forEach((pt, k) => { if (t >= pt) cur = k; });
  const found = cur === S.probes.length - 1;
  for (let i = 0; i < S.N; i++) {
    const c = cellPos(S, pane, i);
    let fill = P.panel2, border = P.dim;
    const out = i < rng.lo || i > rng.hi;
    if (out) { fill = P.bg; border = P.panel2; }
    if (cur >= 0 && i === S.probes[cur].mid) {
      if (found) { fill = P.emerald; border = P.emeraldDk; }
      else { const on = Math.floor((t - S.probeT[cur]) * 10) % 2 === 0; fill = on ? P.gold : P.goldDk; border = P.gold; }
    } else if (!out && cur >= 0) { border = P.goldDk; }
    drawCell(R, c.x, c.y, fill, border, (t - cellAppear(i) - 0.1) / 0.2);
    if (out) R.dither(c.x + 1, c.y + 1, 9, 9, P.panel, i & 1);
  }
  if (cur >= 0) {
    const pr = S.probes[cur], c = cellPos(S, pane, pr.mid), v = S.values[pr.mid];
    const row = Math.floor(pr.mid / S.COLS);
    const label = found ? `${v} = FOUND!` : v < S.target ? `${v} TOO LOW →` : `← ${v} TOO HIGH`;
    const color = found ? P.emerald : P.coral;
    const app = (t - S.probeT[cur]) / 0.2;
    if (row >= 2) R.callout(label, c.x + 5, c.y - 1, { color, dir: 'down', appear: app });
    else R.callout(label, c.x + 5, c.y + 12, { color, dir: 'up', appear: app });
  }
  const y = pane.y + 70;
  R.counter('bin', pane.x + 8, y, cur + 1, { label: 'CHECKS', scale: 2, color: P.gold, smooth: false });
  R.counter('binr', pane.x + pane.w - 8, y, rng.hi - rng.lo + 1, { label: 'RANGE LEFT', scale: 2, color: P.text, align: 'right', smooth: false });
  R.bar(pane.x + 8, pane.y + 100, pane.w - 16, 10, 1 - (rng.hi - rng.lo + 1) / S.N, { color: P.gold });
}

function drawBigLinear(R, pane) {
  const S = R.state, P = R.PAL, t = R.t;
  const wx = pane.x + Math.floor((pane.w - 207) / 2), wy = pane.y + 14;
  R.ctx.drawImage(S.wallTop, wx, wy);
  const n = bigLin(R), px = Math.floor(n / 1e6 * 207 * 51);
  const rows = Math.floor(px / 207), rem = px % 207;
  R.ctx.globalAlpha = 0.6;
  R.rect(wx, wy, 207, rows, P.cyan);
  R.rect(wx, wy + rows, rem, 1, P.cyan);
  R.ctx.globalAlpha = 1;
  if (n < 1e6 && n > 0) R.rect(wx + rem - 2, wy + rows - 1, 3, 3, P.white);
  if (t >= S.bigLinEnd) R.callout('STILL GRINDING...', wx + 103, wy + 40, { color: P.coral, dir: 'down', appear: (t - S.bigLinEnd) / 0.25 });
  const y = pane.y + 70;
  R.counter('blin', pane.x + 8, y, n, { label: 'CHECKS', scale: 2, color: P.cyan, smooth: false, blink: false });
  R.bar(pane.x + 8, pane.y + 100, pane.w - 16, 10, n / 1e6, { color: P.cyan });
}

function drawBigBinary(R, pane) {
  const S = R.state, P = R.PAL, t = R.t;
  const wx = pane.x + Math.floor((pane.w - 207) / 2), wy = pane.y + 14;
  R.ctx.drawImage(S.wallBot, wx, wy);
  const k = bigBin(R), win = bigWindow(S, k);
  R.ctx.globalAlpha = 0.82;
  R.rect(wx, wy, Math.round(win.x0), 51, P.bg);
  R.rect(wx + Math.round(win.x0 + win.w), wy, 207 - Math.round(win.x0 + win.w), 51, P.bg);
  R.ctx.globalAlpha = 1;
  R.border(wx + Math.round(win.x0) - 1, wy - 1, Math.round(win.w) + 2, 53, k >= 20 ? P.emerald : P.gold);
  if (k > 0 && k < 20) {
    const prev = bigWindow(S, k - 1), since = t - S.bigProbeT[k - 1];
    if (since < 0.25) R.rect(wx + Math.round(prev.x0 + prev.w / 2), wy - 3, 1, 57, P.white);
  }
  const cx = wx + win.x0 + win.w / 2;
  S.bottom.cx = cx;
  if (k >= 20) R.callout('FOUND IN 20!', cx + (cx < 135 ? 3 : -3), wy + 25, { color: P.emerald, dir: cx < 135 ? 'left' : 'right', appear: (t - S.bigProbeT[19]) / 0.25 });
  const y = pane.y + 70;
  R.counter('bbin', pane.x + 8, y, k, { label: 'CHECKS', scale: 2, color: P.gold, smooth: false });
  R.counter('bbinr', pane.x + pane.w - 8, y, Math.ceil(1e6 / Math.pow(2, k)), { label: 'RANGE LEFT', scale: 2, color: P.text, align: 'right', smooth: false });
  R.bar(pane.x + 8, pane.y + 100, pane.w - 16, 10, k / 20, { color: P.gold });
}

function drawTakeaway(R) {
  const S = R.state, P = R.PAL, t = R.t, SAFE = R.SAFE, tk = S.tk;
  const lt = t - tk.start;
  R.text('BINARY SEARCH COST', R.W / 2, SAFE.y + 1, { color: P.white, align: 'center' });
  R.text('DATA SIZE', SAFE.x + 6, SAFE.y + 18, { color: P.mid });
  R.text('CHECKS', SAFE.x + SAFE.w - 6, SAFE.y + 18, { color: P.mid, align: 'right' });
  const rows = [['1,000', 10], ['1,000,000', 20], ['1,000,000,000', 30]];
  rows.forEach(([label, v], i) => {
    const a = R.clamp((t - S.tkRows[i]) / 0.3, 0, 1);
    if (a <= 0) return;
    const y = SAFE.y + 30 + i * 32 + Math.round((1 - R.ease.outBack(a)) * 8);
    R.box(SAFE.x + 2, y, SAFE.w - 4, 28, { fill: P.panel, border: i === 2 ? P.gold : P.dim });
    R.text(label, SAFE.x + 8, y + 5, { color: P.white });
    R.text('ITEMS', SAFE.x + 8, y + 16, { color: P.mid });
    R.bar(SAFE.x + 92, y + 9, Math.round(100 * v / 30 * R.ease.out(a)), 10, 1, { color: P.gold, shadow: false });
    R.text(String(v), SAFE.x + SAFE.w - 8, y + 7, { color: P.gold, scale: 2, align: 'right' });
  });
  const h = R.clamp((t - S.tkHalve) / 0.18, 0, 1);
  if (h > 0) {
    const drop = Math.round((1 - R.ease.outBounce(h)) * -40);
    R.text('HALVE IT.', R.W / 2, SAFE.y + 134 + drop, { color: P.coral, scale: 4, align: 'center', outline: P.coralDk });
  }
  if (t >= S.tkDouble) {
    R.text('DOUBLE THE DATA', R.W / 2, SAFE.y + 180, { color: P.cyan, align: 'center' });
    R.text('= JUST +1 STEP', R.W / 2, SAFE.y + 192, { color: P.cyan, scale: 2, align: 'center' });
  }
  const msg = 'SORT FIRST. SEARCH SMART.';
  if (t >= S.tkSort) R.typeText(msg, R.W / 2 - R.textWidth(msg) / 2, SAFE.y + 226, (t - S.tkSort) / 0.9, { color: P.gold });
}
