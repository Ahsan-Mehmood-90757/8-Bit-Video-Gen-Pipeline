/* attention_v3.js — pull the viewer's eye to where the action is.
 *
 *   R.spotlight(x, y, w, h, {dim, desat, pad})
 *       Call every frame while a zone is "active" (world coords inside R.world, screen coords outside).
 *       Everything OUTSIDE the zone is desaturated toward grey and dimmed toward the background colour.
 *       The zone and the strength glide smoothly between calls; when you stop calling, it fades away.
 *       Text pops (micro-text, banner, stamp) are drawn after the spotlight, so they stay bright.
 *   Combine with focal camera moves:  Camera.track([{t, fit:[x,y,w,h]}])  /  Camera.fitTo([x,y,w,h])
 */
(function () {
  'use strict';
  const Retro = window.Retro, R = Retro.R, I = R._internal;
  let req = null;
  const cur = { x: 0, y: 0, w: 0, h: 0, amt: 0, dim: 0.55, desat: 0.85, live: false };

  R.spotlight = function (x, y, w, h, o = {}) {
    const p = o.pad === undefined ? 3 : o.pad;
    let r = { x: x - p, y: y - p, w: w + 2 * p, h: h + 2 * p };
    if (R.inWorld()) {
      const a = R.toScreen(r.x, r.y), b = R.toScreen(r.x + r.w, r.y + r.h);
      r = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    req = { r, dim: o.dim === undefined ? 0.55 : o.dim, desat: o.desat === undefined ? 0.85 : o.desat };
  };

  function hexRgb(h) { const n = parseInt(String(h).slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  function apply() {
    const k = 1 - Math.pow(1 - 0.22, R.dt * 60);
    if (req) {
      if (!cur.live || cur.amt < 0.02) Object.assign(cur, req.r);            // first frame: snap, then glide
      for (const f of ['x', 'y', 'w', 'h']) cur[f] += (req.r[f] - cur[f]) * k;
      cur.dim += (req.dim - cur.dim) * k; cur.desat += (req.desat - cur.desat) * k;
      cur.amt += (1 - cur.amt) * k; cur.live = true;
    } else {
      cur.amt += (0 - cur.amt) * k;
      if (cur.amt < 0.01) { cur.amt = 0; cur.live = false; }
    }
    req = null;
    if (cur.amt <= 0.01) return;
    const ctx = I.ctx, W = R.W, H = R.H;
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const [br, bgc, bb] = hexRgb(R.PAL.bg);
    const ds = cur.desat * cur.amt, dm = cur.dim * cur.amt;
    const T = ctx.getTransform();                                         // follow screen shake
    const x0 = Math.round(cur.x + T.e), y0 = Math.round(cur.y + T.f), x1 = Math.round(cur.x + cur.w + T.e), y1 = Math.round(cur.y + cur.h + T.f);
    for (let y = 0; y < H; y++) {
      const inRow = y >= y0 && y < y1;
      for (let x = 0; x < W; x++) {
        if (inRow && x >= x0 && x < x1) continue;
        const i = (y * W + x) * 4;
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        r += (l - r) * ds; g += (l - g) * ds; b += (l - b) * ds;            // desaturate
        d[i] = r + (br - r) * dm; d[i + 1] = g + (bgc - g) * dm; d[i + 2] = b + (bb - b) * dm;   // dim toward bg
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // runs right after the episode draws, BEFORE labels / micro-text are flushed (so text stays bright)
  Retro.hooks.afterDraw.unshift(apply);
  Retro.hooks.reset.push(() => { req = null; Object.assign(cur, { amt: 0, live: false }); });
})();
