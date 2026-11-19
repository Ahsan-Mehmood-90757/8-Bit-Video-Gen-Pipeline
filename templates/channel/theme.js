/* theme.js — this channel's visual identity. Loaded ONLY for episodes inside this channel folder.
 * Change palette / background / overlay here and every episode of this channel follows.
 * Episodes should use R.PAL.<role> colors (never hard-coded hex) so they stay on-brand.
 */
Retro.defineTheme({
  name: '{{SLUG}}',
  handle: '{{HANDLE}}',

  // Palette roles used by the engine + episodes. {{PALETTE_NAME}} preset.
  palette: {{PALETTE}},

  // Background style: 'grid' | 'blueprint' | 'dots' | 'scan' | 'plain'
  backgroundStyle: '{{BG}}',

  background(R) {
    const P = R.PAL, W = R.W, H = R.H;
    const style = this.backgroundStyle;
    if (style === 'grid') R.grid(0, 0, W, H, 15, P.grid);
    else if (style === 'blueprint') { R.grid(0, 0, W, H, 6, P.grid); R.grid(0, 0, W, H, 30, P.dim); }
    else if (style === 'dots') { for (let y = 3; y < H; y += 8) for (let x = 3; x < W; x += 8) R.px(x, y, P.grid); }
    else if (style === 'scan') { for (let y = 0; y < H; y += 3) R.hline(0, y, W, P.grid); }
  },

  // Drawn on top of every frame: small channel handle under the footer strip (watermark for re-uploads).
  overlay(R) {
    if (!this.handle || this.handle.indexOf('{{') === 0) return;
    R.text(this.handle, R.W / 2, R.FOOTER.y + R.FOOTER.h + 3, { color: R.PAL.dim, align: 'center', shadow: false });
  },

  // Optional helpers episodes can call to keep a consistent look:
  header(R, text, color) {
    R.text(text, R.W / 2, R.SAFE.y + 1, { color: color || R.PAL.white, align: 'center' });
  }
});
