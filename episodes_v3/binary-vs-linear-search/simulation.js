/* Linear Search vs Binary Search — V3 Visual-First (no TTS, no voiceover, no subtitles), 32 s.
 * Sorted 16-item array, target 72 (index 13). Binary: 3 probes (mid 7 -> 11 -> 13). Linear: 14 checks.
 * Layout (1080x1920 px -> /4 low-res): top half y 340..840 (85..210), divider y 880 (220),
 * bottom half y 920..1420 (230..355), HUD badge at y 275 (~66); everything inside the UI-safe box.
 */
const DATA = [2, 5, 8, 12, 16, 23, 29, 34, 38, 45, 51, 58, 64, 72, 85, 91];
const TARGET = 72, T_IDX = 13;
const GRID = { x0: 27, pitch: 25, cell: 24 };
const HALF = {
  top: { head: 88, r1: 103, r2: 142, call: 192, color: 'cyan', label: 'LINEAR SEARCH O(N)' },
  bot: { head: 233, r1: 249, r2: 288, call: 337, color: 'gold', label: 'BINARY SEARCH O(LOG N)' }
};
const COL = {
  bg: '#0F172A', cyan: '#38BDF8', amber: '#FACC15', green: '#4ADE80', red: '#F87171', gray: '#94A3B8', dead: '#1E293B',
  idle: '#17243D', idleBorder: '#4B5D78', missFill: '#3B1620', midFill: '#3A3008', text: '#E2E8F0', idx: '#475569'
};
const PROBES = [{ lo: 0, hi: 15, mid: 7 }, { lo: 8, hi: 15, mid: 11 }, { lo: 12, hi: 15, mid: 13 }];
const HOP_T = [6.0, 9.5, 12.5];                                 // binary hops (readable, rhythmic)
const LIN2_T = [5.0, 7.0, 9.0, 11.0, 13.0, 15.0];                // linear: idx 0..5 during phase 2
const LIN3_T = (() => { const out = [16.4]; for (let k = 0; k < 7; k++) out.push(out[k] + (1.05 - 0.3 * k / 6)); return out; })(); // idx 6..13, accelerating
const LIN_T = LIN2_T.concat(LIN3_T);                             // 14 checks -> found at index 13
const CHECK_HOLD = 0.32;                                         // cyan "checking" before turning red

const cellXY = (h, i) => ({ x: GRID.x0 + (i % 8) * GRID.pitch, y: i < 8 ? h.r1 : h.r2 });

Retro.defineSim({
  seed: 72,
  defaultBeats: [{ id: 'setup', dur: 4.5 }, { id: 'hops', dur: 11.5 }, { id: 'grind', dur: 9 }, { id: 'scale', dur: 7 }],

  setup(R) {
    Object.assign(R.PAL, {
      bg: COL.bg, panel: '#131E33', panel2: COL.idle, grid: '#152038', dim: COL.idleBorder, mid: COL.gray, text: COL.text,
      cyan: COL.cyan, gold: COL.amber, emerald: COL.green, coral: COL.red, black: '#060A14', white: '#F8FAFC'
    });
    const S = R.state;
    S.linSteps = 0; S.binSteps = 0; S.linChange = -1; S.binChange = -1;
    // world view = whole UI-safe box; gentle settle-in (zoom 0.94 -> 1.0, never > 1 so nothing clips)
    const A = R.SAFE, cx = A.x + A.w / 2, cy = A.y + A.h / 2;
    Camera.track([{ t: 0, x: cx, y: cy, zoom: 0.94 }, { t: 1.6, x: cx, y: cy, zoom: 1.0, ease: 'out' }]);
    S.cx = cx;
  },

  update(R) {
    const S = R.state, t = R.t;
    // phase 1: grids materialize with soft wooden ticks
    for (let i = 0; i < 16; i += 2) if (R.crossed(popT('top', i))) R.sfx('lin_tick', i % 4 ? 5 : 0, { vol: 1.0, pan: -0.25 });
    for (let i = 1; i < 16; i += 2) if (R.crossed(popT('bot', i))) R.sfx('lin_tick', i % 4 === 1 ? 7 : 2, { vol: 1.0, pan: 0.25 });

    // soft C3+G3 bed under all phases (phone-audible register) so sparse sections never drop out
    const fadeIn = R.clamp(t / 1.0, 0, 1), fadeOut = R.clamp((32 - t) / 1.2, 0, 1);
    const swell = (t < 4.5 ? 1.0 : t < 16 ? 0.8 : t < 25 ? 1.0 : 0.75) * fadeIn * fadeOut;
    R.synth('bed', { freq: 130.81, wave: 'triangle', gain: 0.13 * swell, cutoff: 700, res: 0.1 });
    R.synth('bed5', { freq: 196.0, wave: 'triangle', gain: 0.06 * swell, cutoff: 700, res: 0.1, pan: 0.1 });

    // linear search ticks (soft G3 wooden click) — every check
    LIN_T.forEach((lt, k) => {
      if (R.crossed(lt)) {
        S.linSteps = k + 1; S.linChange = t;
        if (k === T_IDX) R.sfx('lin_found', 0, { pan: -0.2 });
        else R.sfx('lin_tick', 0, { pan: -0.3 });
      }
    });
    // binary hops: C4 -> E4 -> G4 marimba notes, swoosh on every half eliminated, victory chord on lock-on
    HOP_T.forEach((ht, k) => {
      if (R.crossed(ht)) { S.binSteps = k + 1; S.binChange = t; R.sfx('bin_hop', [0, 4, 7][k], { pan: 0.25 }); }
      if (k < 2 && R.crossed(ht + 0.9)) R.sfx('bin_drop', 0, { pan: 0.2 });
    });
    if (R.crossed(HOP_T[2] + 0.12)) { R.sfx('bin_win', 0, { pan: 0.15 }); R.flash(COL.green, 5); }

    // phase 4 card
    const sc = R.beat('scale').start;
    if (R.crossed(sc)) R.sfx('soft_swoosh');
    if (t >= sc + 1.2 && t < sc + 3.0 && R.every('card_ticks', 0.12, sc + 1.2)) R.sfx('lin_tick', 0, { vol: 0.5, pan: -0.2 });
    if (R.crossed(sc + 3.6)) R.sfx('bin_win', -12, { pan: 0.1 });           // C4-E4-G4 version of the chord
    if (R.crossed(sc + 4.8)) R.sfx('bin_hop', 7, { vol: 0.8 });
  },

  draw(R) {
    const S = R.state, t = R.t, ctx = R.ctx, A = R.SAFE;
    const sc = R.beat('scale').start;
    R.grid(0, 0, R.W, R.H, 12, '#131D33');
    const gridAlpha = 1 - R.clamp((t - sc) / 0.5, 0, 1);
    if (gridAlpha > 0) {
      ctx.save(); ctx.globalAlpha = gridAlpha;
      drawHud(R, S);
      R.world(() => {
        drawHalfFrame(R, HALF.top, S.linSteps, S.linChange);
        drawHalfFrame(R, HALF.bot, S.binSteps, S.binChange);
        R.dashed(A.x, 220, A.x + A.w, 220, '#334155', 2, 2);             // divider at y 880
        drawLinear(R, S);
        drawBinary(R, S);
      });
      ctx.restore();
      // phase-1 micro callouts
      R.micro('BRUTE FORCE SCAN', S.cx, HALF.top.call, { t0: 1.8, dur: 2.7, style: 'tag', color: COL.cyan, pointer: false, at: [0, 0] });
      R.micro('DIVIDE & ELIMINATE', S.cx, HALF.bot.call, { t0: 2.2, dur: 2.3, style: 'tag', color: COL.amber, pointer: false, at: [0, 0] });
    }
    if (t >= sc + 0.4) drawScaleCard(R, S, sc);
  }
});

// ==================================================================== helpers
function popT(which, i) { return (which === 'top' ? 0.25 : 0.4) + i * 0.05; }

function drawHud(R, S) {
  const t = R.t, A = R.SAFE, label = 'FIND TARGET: [ 72 ]', w = R.textWidth(label) + 12, x = Math.round(A.x + A.w / 2 - w / 2), y = 66;
  const pulse = t < 4.5 && Math.floor(t * 2) % 2 === 0;
  R.box(x, y, w, 13, { fill: '#1A1505', border: pulse ? '#FFFFFF' : COL.amber, shadow: false });
  const tx = x + 6;
  R.text('FIND TARGET: [ ', tx, y + 3, { color: COL.text, shadow: false });
  R.text('72', tx + R.textWidth('FIND TARGET: [ ') + 1, y + 3, { color: COL.amber, shadow: false });
  R.text(' ]', tx + R.textWidth('FIND TARGET: [ 72') + 1, y + 3, { color: COL.text, shadow: false });
}

function drawHalfFrame(R, h, steps, changedAt) {
  const flash = R.t - changedAt < 0.12;
  R.tag(h.label, ...xy(R, GRID.x0, h.head), h === HALF.top ? COL.cyan : COL.amber);
  const txt = 'STEPS: ' + steps;
  R.text(txt, GRID.x0 + 8 * GRID.pitch - 1, h.head + 2, { color: flash ? '#FFFFFF' : (h === HALF.top ? COL.cyan : COL.amber), align: 'right', shadow: false });
}
// R.tag draws in screen space; convert a world point (camera settle-in) to screen
function xy(R, x, y) { const p = R.toScreen(x, y); return [Math.round(p.x), Math.round(p.y)]; }

function drawCell(R, h, i, st, appear = 1) {
  const { x, y } = cellXY(h, i), c = GRID.cell;
  const k = R.clamp(appear, 0, 1);
  if (k <= 0) return;
  const s = Math.max(2, Math.round(c * R.clamp(R.ease.outBack(k), 0, 1.15)));
  const o = (c - s) / 2;
  const style = {
    idle:  { fill: COL.idle, border: COL.idleBorder, text: COL.text },
    check: { fill: COL.cyan, border: '#FFFFFF', text: COL.bg },
    miss:  { fill: COL.missFill, border: COL.red, text: COL.red },
    dead:  { fill: COL.dead, border: '#26344A', text: '#5B6B82' },
    mid:   { fill: COL.midFill, border: COL.amber, text: COL.amber },
    found: { fill: COL.green, border: '#FFFFFF', text: COL.bg }
  }[st];
  R.box(x + o, y + o, s, s, { fill: style.fill, border: style.border, shadow: false, label: 'cell ' + i });
  if (st === 'mid') R.border(x - 1, y - 1, c + 2, c + 2, COL.amber);
  if (k >= 0.8) R.digits(String(DATA[i]), x + c / 2, y + 7, { color: style.text, scale: 2, align: 'center' });
}

function laneIndex(R, h, i) {
  const { x, y } = cellXY(h, i);
  R.text(String(i), x + GRID.cell / 2, y + GRID.cell + 4, { color: COL.idx, align: 'center', shadow: false });
}

// ---------------------------------------------------------------- linear (top)
function drawLinear(R, S) {
  const t = R.t, h = HALF.top;
  let cur = -1;
  for (let i = 0; i < 16; i++) {
    const ct = LIN_T[i];
    let st = 'idle';
    if (ct !== undefined && t >= ct) st = i === T_IDX ? 'found' : (t - ct < CHECK_HOLD ? 'check' : 'miss');
    if (ct !== undefined && t >= ct) cur = i;
    drawCell(R, h, i, st, (t - popT('top', i)) / 0.22);
    if (t > popT('top', i) + 0.2) laneIndex(R, h, i);
  }
  // scan cursor + MISS pops (lane below the checked cell)
  if (cur >= 0 && cur !== T_IDX) {
    const { x, y } = cellXY(h, cur);
    R.micro('MISS', x + GRID.cell / 2, y + GRID.cell, { t0: LIN_T[cur] + CHECK_HOLD, dur: 0.5, style: 'warn', at: [0, 8], pointer: false });
  }
  if (t >= LIN_T[T_IDX]) {
    const { x, y } = cellXY(h, T_IDX);
    glow(R, x, y);
    R.micro('FOUND: 14 OPS', S.cx, h.call, { t0: LIN_T[T_IDX] + 0.1, dur: 25.0 - LIN_T[T_IDX] - 0.1, style: 'ok', pointer: false, at: [0, 0] });
  }
}

// ---------------------------------------------------------------- binary (bottom)
function binState(t) {
  let hop = -1;
  HOP_T.forEach((ht, k) => { if (t >= ht) hop = k; });
  const dead = new Array(16).fill(false);
  const wipe = (from, to, t0) => { for (let j = from; j <= to; j++) if (t >= t0 + (j - from) / Math.max(1, to - from + 1) * 0.45) dead[j] = true; };
  if (t >= HOP_T[0] + 0.9) wipe(0, 7, HOP_T[0] + 0.9);
  if (t >= HOP_T[1] + 0.9) wipe(8, 11, HOP_T[1] + 0.9);
  if (t >= HOP_T[2] + 0.6) { [12, 14, 15].forEach(j => { if (t >= HOP_T[2] + 0.6 + (j === 12 ? 0 : 0.1 * (j - 13))) dead[j] = true; }); }
  let lo = 0, hi = 15;
  if (t >= HOP_T[0] + 1.35) lo = 8;
  if (t >= HOP_T[1] + 1.35) lo = 12;
  return { hop, dead, lo, hi, found: t >= HOP_T[2] };
}

function drawBinary(R, S) {
  const t = R.t, h = HALF.bot, B = binState(t);
  const midIdx = B.hop >= 0 ? PROBES[B.hop].mid : -1;
  for (let i = 0; i < 16; i++) {
    let st = B.dead[i] ? 'dead' : 'idle';
    if (i === midIdx) st = B.found ? 'found' : (B.dead[i] ? 'dead' : (t < HOP_T[B.hop] + 1.35 ? 'mid' : 'idle'));
    drawCell(R, h, i, st, (t - popT('bot', i)) / 0.22);
  }
  const showPtr = t >= 4.6;
  const busy = new Set();
  if (showPtr && !B.found) {
    bracket(R, h, B.lo, 'L', COL.green); bracket(R, h, B.hi, 'R', COL.red);
    pointerTag(R, h, B.lo, 'LOW', COL.green, false); busy.add(B.lo);
    pointerTag(R, h, B.hi, 'HIGH', COL.red, false); busy.add(B.hi);
  }
  const midLive = B.hop >= 0 && t < HOP_T[B.hop] + 1.35;          // MID disappears once its half is dropped
  if (midIdx >= 0 && !B.found && midLive) { pointerTag(R, h, midIdx, 'MID', COL.amber, true); busy.add(midIdx); }
  if (B.found) {
    const { x, y } = cellXY(h, T_IDX);
    bracket(R, h, T_IDX, 'L', COL.green); bracket(R, h, T_IDX, 'R', COL.green);
    glow(R, x, y);
    pointerTag(R, h, T_IDX, 'LOCK', COL.green, true); busy.add(T_IDX);
  }
  for (let i = 0; i < 16; i++) if (!busy.has(i) && t > popT('bot', i) + 0.2) laneIndex(R, h, i);

  // callouts
  const call = (txt, k, style, color, dur) => {
    const { x, y } = cellXY(h, PROBES[k].mid);
    const ax = x + GRID.cell / 2, ay = y + GRID.cell / 2;
    R.micro(txt, ax, ay, { t0: HOP_T[k] + 0.35, dur, style, color, pointer: false, at: [S.cx - ax, h.call - ay] });  // cell is already highlighted: no line across the grid
  };
  call('34 < 72: DROP LEFT', 0, 'tag', COL.amber, 2.6);
  call('58 < 72: DROP LEFT', 1, 'tag', COL.amber, 2.6);
  call('FOUND IN 3 STEPS!', 2, 'ok', COL.green, 16.0 - HOP_T[2] - 0.35);
  if (t >= 16.0) R.micro('DONE: 3 OPS', S.cx, h.call, { t0: 16.0, dur: 9.0, style: 'ok', pointer: false, at: [0, 0] });
}

function bracket(R, h, i, side, color) {
  const { x, y } = cellXY(h, i), c = GRID.cell;
  const bx = side === 'L' ? x - 2 : x + c;
  R.rect(bx, y - 2, 2, c + 4, color);
  const tx = side === 'L' ? bx : bx - 2;
  R.rect(tx, y - 2, 4, 2, color); R.rect(tx, y + c, 4, 2, color);
}

function pointerTag(R, h, i, label, color, arrow) {
  const { x, y } = cellXY(h, i), cx = x + GRID.cell / 2, ly = y + GRID.cell + 1;
  if (arrow) { R.rect(cx, ly, 1, 1, color); R.rect(cx - 1, ly + 1, 3, 1, color); R.rect(cx - 2, ly + 2, 5, 1, color); }
  const p = R.toScreen(cx, ly + 3);
  R.tag(label, Math.round(p.x), Math.round(p.y), color, { align: 'center' });
}

function glow(R, x, y) {
  const c = GRID.cell, k = 0.5 + 0.5 * Math.sin(R.t * 6);
  const ctx = R.ctx;
  ctx.save(); ctx.globalAlpha *= 0.35 + 0.45 * k;
  R.border(x - 3, y - 3, c + 6, c + 6, COL.green);
  ctx.restore();
}

// ---------------------------------------------------------------- phase 4: scale card
function drawScaleCard(R, S, sc) {
  const t = R.t - sc, A = R.SAFE, cx = A.x + A.w / 2, ctx = R.ctx;
  const a = R.clamp((t - 0.4) / 0.5, 0, 1);
  ctx.save(); ctx.globalAlpha = a;
  R.text('1,000,000 ITEMS:', cx, 96, { color: COL.text, scale: 2, align: 'center' });
  const barX = GRID.x0, barW = GRID.x0 + 8 * GRID.pitch - 1 - barX;
  // linear
  if (t >= 1.0) {
    R.text('LINEAR:', barX, 128, { color: COL.red });
    const k = R.ease.inOut(R.clamp((t - 1.2) / 1.8, 0, 1));
    R.box(barX, 140, barW, 16, { fill: '#1A0E14', border: '#3B1620', shadow: false });
    R.rect(barX + 2, 142, Math.round((barW - 4) * k), 12, COL.red);
    R.text(R.fmt(Math.round(1e6 * k)) + ' STEPS', cx, 164, { color: COL.red, scale: 2, align: 'center' });
  }
  // binary
  if (t >= 3.2) {
    R.text('BINARY:', barX, 204, { color: COL.green });
    R.box(barX, 216, barW, 16, { fill: '#0C1A12', border: '#16351F', shadow: false });
    const pop = R.clamp((t - 3.6) / 0.15, 0, 1);
    if (pop > 0) R.rect(barX + 2, 218, Math.max(2, Math.round(4 * pop)), 12, COL.green);
    if (t >= 3.6) R.text('20 STEPS MAX', cx, 240, { color: COL.green, scale: 2, align: 'center' });
  }
  ctx.restore();
  if (t >= 4.8) R.micro('REQUIRES SORTED DATA', cx, 300, { t0: sc + 4.8, dur: 10, style: 'tag', color: COL.amber, pointer: false, at: [0, 0] });
}
