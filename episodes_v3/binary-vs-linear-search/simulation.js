/* Linear Search vs Binary Search — V3 Visual-First (no TTS / voiceover / subtitles), 32 s.
 * Sorted 16 items, target 72 (index 13): binary needs 3 probes (mid 7 -> 11 -> 13), linear needs 14 checks.
 *
 * Attention rules applied here:
 *  - Hook (0-2.2 s): both arrays snap in with the two 72s pulsing + a 4-word question.
 *  - Text is reactive only: every element <= 4 words, pops in (0.7 -> 1.05 -> 1.0 / 120 ms) on its event,
 *    then dims or clears. No static headers, HUD badges or index labels.
 *  - Every action gets a focal camera move (fit keyframes) + a spotlight that dims & desaturates the rest.
 *  - Audio: only event sounds (no bed / drone), all with clean envelopes; silence between events.
 */
const DATA = [2, 5, 8, 12, 16, 23, 29, 34, 38, 45, 51, 58, 64, 72, 85, 91];
const T_IDX = 13;
const GRID = { x0: 27, pitch: 25, cell: 24 };
const HALF = { top: { r1: 103, r2: 142, head: 88, call: 186 }, bot: { r1: 249, r2: 288, head: 233, call: 333 } };
const COL = {
  bg: '#0F172A', cyan: '#38BDF8', amber: '#FACC15', green: '#4ADE80', red: '#F87171', gray: '#94A3B8', dead: '#1E293B',
  idle: '#17243D', idleBorder: '#4B5D78', missFill: '#3B1620', midFill: '#3A3008', text: '#E2E8F0'
};
const PROBES = [{ lo: 0, hi: 15, mid: 7 }, { lo: 8, hi: 15, mid: 11 }, { lo: 12, hi: 15, mid: 13 }];
const HOP_T = [6.2, 9.8, 13.4];
const LIN_T = (() => {                                             // linear checks: pairs between hops, then a grind
  const p2 = [4.6, 5.2, 8.3, 8.9, 11.9, 12.5];
  const p3 = [16.9];
  for (let k = 0; k < 7; k++) p3.push(p3[k] + (0.95 - 0.25 * k / 6));
  return p2.concat(p3);
})();
const CHECK_HOLD = 0.3;
const SCALE_T = 25.0;                                             // card runs 25.0 - 31.0 s (tight, no dead hold)

const cellXY = (h, i) => ({ x: GRID.x0 + (i % 8) * GRID.pitch, y: i < 8 ? h.r1 : h.r2 });
const gridBox = (h) => [GRID.x0 - 3, h.r1 - 3, 8 * GRID.pitch + 5, (h.r2 - h.r1) + GRID.cell + 20];

Retro.defineSim({
  seed: 72,
  defaultBeats: [{ id: 'setup', dur: 4.5 }, { id: 'hops', dur: 11.5 }, { id: 'grind', dur: 9 }, { id: 'scale', dur: 7 }],

  setup(R) {
    Object.assign(R.PAL, { bg: COL.bg, panel: '#131E33', panel2: COL.idle, grid: '#152038', dim: COL.idleBorder,
      mid: COL.gray, text: COL.text, cyan: COL.cyan, gold: COL.amber, emerald: COL.green, coral: COL.red, black: '#060A14', white: '#F8FAFC' });
    const S = R.state, A = R.SAFE;
    S.cx = A.x + A.w / 2;
    // ---- focal camera: overview (0.86) <-> fit-to-active-half, never exceeding the safe zone
    const OV = { x: S.cx, y: A.y + A.h / 2, zoom: 0.86 };
    const TOP = { fit: gridBox(HALF.top) }, BOT = { fit: gridBox(HALF.bot) };
    const keys = [{ t: 0, ...OV }];
    HOP_T.forEach((ht) => keys.push({ t: ht - 0.45, ...OV }, { t: ht - 0.05, ...BOT }, { t: ht + 1.55, ...BOT }, { t: ht + 1.95, ...OV }));
    keys.push({ t: 16.3, ...OV }, { t: 16.8, ...TOP }, { t: 23.2, ...TOP }, { t: 23.7, ...OV });
    Camera.track(keys);
  },

  update(R) {
    const t = R.t;
    LIN_T.forEach((lt, k) => { if (R.crossed(lt)) R.sfx(k === T_IDX ? 'lin_found' : 'lin_tick', 0, { pan: -0.3 }); });
    HOP_T.forEach((ht, k) => {
      if (R.crossed(ht)) R.sfx('bin_hop', [0, 4, 7][k], { pan: 0.25 });
      if (k < 2 && R.crossed(ht + 0.9)) R.sfx('bin_drop', 0, { pan: 0.2 });
    });
    if (R.crossed(HOP_T[2] + 0.12)) { R.sfx('bin_win', 0, { pan: 0.15 }); R.flash(COL.green, 5); }
    if (R.crossed(23.5)) R.sfx('bin_hop', 4, { vol: 0.9 });
    // scale card
    if (R.crossed(SCALE_T)) {
      R.sfx('soft_swoosh');
      // the two arrays dissolve into data packets that fly into the card (no empty transition)
      R.world(() => {
        for (const h of [HALF.top, HALF.bot]) R.emit(36, { x: GRID.x0 + 100, y: h.r1 + 30, angle: -Math.PI / 2, spread: Math.PI, speed: [0.8, 2.4], drag: 0.05, life: [0.5, 1.1], kind: 'packet', color: [COL.cyan, COL.amber, COL.red, COL.green] });
      });
    }
    if (t >= SCALE_T + 0.6 && t < SCALE_T + 2.2 && R.every('card_ticks', 0.15, SCALE_T + 0.6)) R.sfx('lin_tick', 0, { vol: 0.7, pan: -0.2 });
    if (R.crossed(SCALE_T + 3.0)) R.sfx('bin_win', -12, { pan: 0.1 });
    if (R.crossed(SCALE_T + 4.2)) R.sfx('bin_hop', 7, { vol: 0.8 });
  },

  draw(R) {
    const S = R.state, t = R.t, ctx = R.ctx;
    R.grid(0, 0, R.W, R.H, 12, '#131D33');
    const gridAlpha = 1 - R.clamp((t - SCALE_T) / 0.4, 0, 1);
    if (gridAlpha > 0) {
      ctx.save(); ctx.globalAlpha = gridAlpha;
      R.world(() => {
        drawLinear(R, S);
        drawBinary(R, S);
        if (t < 2.2) hookPulse(R);
        attention(R, S);
      });
      ctx.restore();
      reactiveText(R, S);
    }
    R.hookBanner('WHICH FINDS\n72 FIRST?', { t0: 0, dur: 2.2, color: COL.amber });
    if (t >= SCALE_T + 0.3) drawScaleCard(R, S);
  }
});

// ==================================================================== state helpers
function linCount(t) { return LIN_T.filter(lt => t >= lt).length; }
function binState(t) {
  let hop = -1;
  HOP_T.forEach((ht, k) => { if (t >= ht) hop = k; });
  const dead = new Array(16).fill(false);
  const wipe = (from, to, t0) => { for (let j = from; j <= to; j++) if (t >= t0 + (j - from) / Math.max(1, to - from + 1) * 0.45) dead[j] = true; };
  if (t >= HOP_T[0] + 0.9) wipe(0, 7, HOP_T[0] + 0.9);
  if (t >= HOP_T[1] + 0.9) wipe(8, 11, HOP_T[1] + 0.9);
  if (t >= HOP_T[2] + 0.6) [12, 14, 15].forEach(j => { dead[j] = true; });
  let lo = 0, loT = 4.55;
  if (t >= HOP_T[0] + 1.35) { lo = 8; loT = HOP_T[0] + 1.35; }
  if (t >= HOP_T[1] + 1.35) { lo = 12; loT = HOP_T[1] + 1.35; }
  return { hop, dead, lo, loT, hi: 15, found: t >= HOP_T[2] };
}

// ==================================================================== drawing (world space)
function drawCell(R, h, i, st) {
  const { x, y } = cellXY(h, i), c = GRID.cell;
  const style = {
    idle:  { fill: COL.idle, border: COL.idleBorder, text: COL.text },
    check: { fill: COL.cyan, border: '#FFFFFF', text: COL.bg },
    miss:  { fill: COL.missFill, border: COL.red, text: COL.red },
    dead:  { fill: COL.dead, border: '#26344A', text: '#5B6B82' },
    mid:   { fill: COL.midFill, border: COL.amber, text: COL.amber },
    found: { fill: COL.green, border: '#FFFFFF', text: COL.bg }
  }[st];
  R.box(x, y, c, c, { fill: style.fill, border: style.border, shadow: false, label: 'cell ' + i });
  if (st === 'mid' && cellVisible(R, h, i)) R.border(x - 1, y - 1, c + 2, c + 2, COL.amber);
  R.digits(String(DATA[i]), x + c / 2, y + 7, { color: style.text, scale: 2, align: 'center' });
}

function hookPulse(R) {                                       // high-contrast hook: both 72s blink amber
  if (Math.floor(R.t * 6) % 2) return;
  for (const h of [HALF.top, HALF.bot]) { if (!cellVisible(R, h, T_IDX)) continue; const { x, y } = cellXY(h, T_IDX); R.border(x - 2, y - 2, GRID.cell + 4, GRID.cell + 4, COL.amber, 2); }
}

function drawLinear(R) {
  const t = R.t, h = HALF.top;
  for (let i = 0; i < 16; i++) {
    const ct = LIN_T[i];
    let st = 'idle';
    if (ct !== undefined && t >= ct) st = i === T_IDX ? 'found' : (t - ct < CHECK_HOLD ? 'check' : 'miss');
    drawCell(R, h, i, st);
  }
  if (t >= LIN_T[T_IDX]) glow(R, h, T_IDX);
}

function drawBinary(R) {
  const t = R.t, h = HALF.bot, B = binState(t);
  const midIdx = B.hop >= 0 ? PROBES[B.hop].mid : -1, midLive = B.hop >= 0 && t < HOP_T[B.hop] + 1.35;
  for (let i = 0; i < 16; i++) {
    let st = B.dead[i] ? 'dead' : 'idle';
    if (i === midIdx) st = B.found ? 'found' : (B.dead[i] ? 'dead' : (midLive ? 'mid' : 'idle'));
    drawCell(R, h, i, st);
  }
  if (t >= 4.55 && !B.found) { bracket(R, h, B.lo, 'L', COL.green); bracket(R, h, B.hi, 'R', COL.red); }
  if (B.found) { bracket(R, h, T_IDX, 'L', COL.green); bracket(R, h, T_IDX, 'R', COL.green); glow(R, h, T_IDX); }
}

const cellVisible = (R, h, i) => { const { x, y } = cellXY(h, i); return R.inView(x - 3, y - 3, GRID.cell + 6, GRID.cell + 6); };

function bracket(R, h, i, side, color) {
  if (!cellVisible(R, h, i)) return;                               // never draw fragments cut by the view edge
  const { x, y } = cellXY(h, i), c = GRID.cell, bx = side === 'L' ? x - 2 : x + c;
  R.rect(bx, y - 2, 2, c + 4, color);
  const tx = side === 'L' ? bx : bx - 2;
  R.rect(tx, y - 2, 4, 2, color); R.rect(tx, y + c, 4, 2, color);
}

function glow(R, h, i) {
  if (!cellVisible(R, h, i)) return;
  const { x, y } = cellXY(h, i), c = GRID.cell, ctx = R.ctx;
  ctx.save(); ctx.globalAlpha *= 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(R.t * 6));
  R.border(x - 3, y - 3, c + 6, c + 6, COL.green);
  ctx.restore();
}

// spotlight the zone where the current action happens; everything else dims + desaturates
function attention(R) {
  const t = R.t;
  const linActive = LIN_T.some(lt => t >= lt - 0.1 && t < lt + 0.6);
  const hopActive = HOP_T.some(ht => t >= ht - 0.2 && t < ht + 1.6) || (t >= 16.0 && t < 16.6);
  if (t >= 23.3 && t < SCALE_T) {                                   // final contrast: both 72s, same column
    const a = cellXY(HALF.top, T_IDX), b = cellXY(HALF.bot, T_IDX);
    R.spotlight(a.x - 2, a.y - 2, GRID.cell + 4, b.y - a.y + GRID.cell + 4, { dim: 0.6, desat: 0.9 });
  } else if (hopActive) R.spotlight(...gridBox(HALF.bot), { dim: 0.6 });
  else if (linActive || (t >= 16.8 && t < 23.3)) R.spotlight(...gridBox(HALF.top), { dim: 0.6 });
}

// ==================================================================== reactive text (<= 4 words, event-tied)
function reactiveText(R, S) {
  const t = R.t;
  const at = (h, i, dy) => { const { x, y } = cellXY(h, i); return R.toScreen(x + GRID.cell / 2, y + dy); };
  const onScreen = (h, i) => { const { x, y } = cellXY(h, i); return R.inView(R.toScreen(x, y).x, R.toScreen(x, y).y, 1, 1) && R.toScreen(x, y + GRID.cell + 14).y < R.SAFE.y + R.SAFE.h; };
  const fixedTag = (txt, h, color, t0, dur, o = {}) => {             // small label at the half's top-left
    const p = R.toScreen(GRID.x0, h.head), w = R.textWidth(txt) + 8;
    if (p.y < R.SAFE.y + 2 || p.y > R.SAFE.y + R.SAFE.h - 14) return;   // that half is off-screen right now
    R.micro(txt, p.x + w / 2, p.y + 6, { t0, dur, style: 'tag', color, pointer: false, fixed: true, at: [0, 0], ...o });
  };

  // half labels: pop when each algorithm is introduced, then stay dim
  fixedTag('LINEAR', HALF.top, COL.cyan, 2.3, SCALE_T - 2.3, { dimAfter: 1.0 });
  fixedTag('BINARY', HALF.bot, COL.amber, 2.6, SCALE_T - 2.6, { dimAfter: 1.0 });

  // step counters: pop on every change, dim between changes
  const steps = (h, n, t0, t1, color) => {
    const p = R.toScreen(GRID.x0 + 8 * GRID.pitch - 1, h.head), txt = 'STEP ' + n, w = R.textWidth(txt) + 8;
    if (p.y < R.SAFE.y + 2 || p.y > R.SAFE.y + R.SAFE.h - 14) return;
    R.micro(txt, p.x - w / 2, p.y + 6, { t0, dur: t1 - t0, style: 'tag', color, pointer: false, fixed: true, at: [0, 0], dimAfter: 0.6 });
  };
  const ln = linCount(t);
  if (ln > 0) steps(HALF.top, ln, LIN_T[ln - 1], ln < LIN_T.length ? LIN_T[ln] : SCALE_T, COL.cyan);
  const B = binState(t);
  if (B.hop >= 0) steps(HALF.bot, B.hop + 1, HOP_T[B.hop], B.hop < 2 ? HOP_T[B.hop + 1] : SCALE_T, COL.amber);

  // linear: intro + MISS on each check (only while that row is on screen)
  const callY = (h) => R.toScreen(0, h.call).y;
  R.micro('BRUTE FORCE SCAN', S.cx, callY(HALF.top), { t0: 4.6, dur: 1.1, style: 'tag', color: COL.cyan, pointer: false, fixed: true, at: [0, 0] });
  if (ln > 0 && ln - 1 !== T_IDX && onScreen(HALF.top, ln - 1)) {
    const p = at(HALF.top, ln - 1, GRID.cell);
    R.micro('MISS', p.x, p.y, { t0: LIN_T[ln - 1] + CHECK_HOLD, dur: 0.45, style: 'warn', pointer: false, fixed: true, at: [0, 9] });
  }
  if (t >= LIN_T[T_IDX]) R.micro('FOUND: 14 OPS', S.cx, callY(HALF.top), { t0: LIN_T[T_IDX] + 0.1, dur: 1.5, style: 'ok', pointer: false, fixed: true, at: [0, 0] });

  // binary: pointers pop when they move, then dim
  const ptr = (label, i, color, t0, dur, dimAfter) => {
    if (!onScreen(HALF.bot, i)) return;
    const p = at(HALF.bot, i, GRID.cell + 9);
    R.micro(label, p.x, p.y, { t0, dur, style: 'badge', color, pointer: false, fixed: true, at: [0, 0], dimAfter });
  };
  if (!B.found && t >= 4.55) {
    ptr('LOW', B.lo, COL.green, B.loT, HOP_T[2] - B.loT, 0.8);
    ptr('HIGH', 15, COL.red, 4.55, HOP_T[2] - 4.55, 0.8);
  }
  HOP_T.forEach((ht, k) => { if (k < 2) ptr('MID', PROBES[k].mid, COL.amber, ht, 1.35); });
  if (B.found) ptr('LOCK', T_IDX, COL.green, HOP_T[2], SCALE_T - HOP_T[2], 1.2);
  const call = (txt, t0, dur, style, color) => R.micro(txt, S.cx, callY(HALF.bot), { t0, dur, style, color, pointer: false, fixed: true, at: [0, 0] });
  call('DIVIDE & ELIMINATE', 5.8, 0.65, 'tag', COL.amber);
  call('34 < 72: DROP LEFT', HOP_T[0] + 0.35, 1.2, 'tag', COL.amber);
  call('58 < 72: DROP LEFT', HOP_T[1] + 0.35, 1.2, 'tag', COL.amber);
  call('FOUND IN 3 STEPS!', HOP_T[2] + 0.2, 1.7, 'ok', COL.green);
  call('DONE: 3 OPS', 16.0, 0.75, 'ok', COL.green);

  // stark contrast once both have found it
  R.micro('14 VS 3', S.cx, R.SAFE.y + R.SAFE.h / 2, { t0: 23.5, dur: 1.4, style: 'stamp', color: COL.amber, pointer: false, fixed: true, at: [0, 0] });
}

// ==================================================================== phase 4: scale card (lines pop, older lines dim)
function drawScaleCard(R, S) {
  const t = R.t - SCALE_T, cx = S.cx;
  const line = (txt, y, t0, dur, color, size, dimAfter) =>
    R.micro(txt, cx, y, { t0: SCALE_T + t0, dur, style: 'tag', color, size, pointer: false, fixed: true, at: [0, 0], dimAfter });
  const barX = GRID.x0, barW = 8 * GRID.pitch - 1;
  line('1,000,000 ITEMS', 104, 0.2, 5.8, COL.text, 2, 1.0);
  if (t >= 0.5) {                                                    // linear bar fills (data counter + sparks at its tip)
    const k = R.ease.inOut(R.clamp((t - 0.6) / 1.6, 0, 1)), tip = barX + 2 + Math.round((barW - 4) * k);
    R.ctx.save(); R.ctx.globalAlpha = t > 3.2 ? 0.45 : 1;
    R.rect(barX, 140, barW, 14, '#1A0E14');
    R.rect(barX + 2, 142, tip - barX - 2, 10, COL.red);
    if (t < 2.2) R.digits(R.fmt(Math.round(1e6 * k)), cx, 160, { color: COL.red, scale: 2, align: 'center' });
    R.ctx.restore();
    if (k > 0 && k < 1) R.stream('linbar', { x: tip, y: 147, rate: 40, angle: 0, spread: 0.9, speed: [0.5, 1.4], life: [0.2, 0.45], kind: 'spark', color: [COL.red, '#FFFFFF'] });
  }
  line('LINEAR: 1,000,000 STEPS', 165, 2.2, 3.8, COL.red, 1, 1.0);
  if (t >= 2.9) {
    const pop = R.clamp((t - 3.0) / 0.15, 0, 1);
    R.rect(barX, 205, barW, 14, '#0C1A12');
    if (pop > 0) R.rect(barX + 2, 207, Math.max(2, Math.round(4 * pop)), 10, COL.green);
    if (t >= 3.0) {
      R.stream('binbar', { x: barX + 5, y: 212, rate: 45, angle: 0, spread: 1.1, speed: [0.5, 1.5], life: [0.4, 0.9], kind: 'dot', size: 2, color: [COL.green, '#BBF7D0'] });
      if (Math.floor(t * 4) % 2 === 0) R.border(barX - 1, 204, 9, 16, COL.green);   // pulse on the tiny green bar
    }
  }
  line('BINARY: 20 STEPS MAX', 230, 3.0, 3.0, COL.green, 1, 1.2);
  line('REQUIRES SORTED DATA', 300, 4.2, 1.8, COL.amber, 1);
}
