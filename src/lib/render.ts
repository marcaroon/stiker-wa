export const SIZE = 512;

export type TextFont = 'impact' | 'display' | 'mono';
export type TextStyle = 'outline' | 'label';

export interface EditState {
  fit: 'cover' | 'contain';
  zoom: number;
  /** pan offset in output pixels */
  offX: number;
  offY: number;
  bg: 'transparent' | 'white' | 'black';
  /** corner radius in output pixels (0 = square, 256 = circle) */
  radius: number;
  /** white die-cut outline thickness in px (0 = off) */
  outline: number;
  text: string;
  textPos: 'top' | 'bottom';
  textColor: string;
  textSize: number;
  textFont: TextFont;
  textStyle: TextStyle;
}

export const defaultEdit = (): EditState => ({
  fit: 'cover',
  zoom: 1,
  offX: 0,
  offY: 0,
  bg: 'transparent',
  radius: 0,
  outline: 0,
  text: '',
  textPos: 'bottom',
  textColor: '#ffffff',
  textSize: 64,
  textFont: 'impact',
  textStyle: 'outline',
});

export function fontFor(st: Pick<EditState, 'textFont' | 'textSize'>) {
  const s = st.textSize;
  switch (st.textFont) {
    case 'display':
      return `800 ${s}px "Bricolage Grotesque Variable", "Arial Black", sans-serif`;
    case 'mono':
      return `700 ${s}px "Space Mono", ui-monospace, monospace`;
    default:
      return `900 ${s}px Impact, "Arial Black", "Helvetica Neue", sans-serif`;
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

function isDark(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

function drawContent(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, st: EditState) {
  ctx.save();
  ctx.clearRect(0, 0, SIZE, SIZE);
  if (st.radius > 0) {
    ctx.beginPath();
    ctx.roundRect(0, 0, SIZE, SIZE, Math.min(st.radius, SIZE / 2));
    ctx.clip();
  }
  if (st.bg !== 'transparent') {
    ctx.fillStyle = st.bg === 'white' ? '#fff' : '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
  if (sw > 0 && sh > 0) {
    const base = st.fit === 'cover' ? Math.max(SIZE / sw, SIZE / sh) : Math.min(SIZE / sw, SIZE / sh);
    const s = base * st.zoom;
    const dw = sw * s;
    const dh = sh * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (SIZE - dw) / 2 + st.offX, (SIZE - dh) / 2 + st.offY, dw, dh);
  }
  ctx.restore();

  const text = st.text.trim();
  if (!text) return;
  ctx.save();
  const size = st.textSize;
  ctx.font = fontFor(st);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, text, SIZE - 56);
  const lh = size * (st.textStyle === 'label' ? 1.32 : 1.08);
  const pad = 18 + Math.min(st.radius, 140) * 0.28;
  const y0 = st.textPos === 'top' ? pad : SIZE - pad - lh * lines.length;
  lines.forEach((l, i) => {
    const cy = y0 + i * lh + lh / 2;
    if (st.textStyle === 'label') {
      // label-maker tape: solid strip, ink text, slight alternating tilt
      const w = Math.min(SIZE - 20, ctx.measureText(l).width + size * 0.6);
      ctx.save();
      ctx.translate(SIZE / 2, cy);
      ctx.rotate(((i % 2 ? 1 : -1) * 1.6 * Math.PI) / 180);
      ctx.fillStyle = st.textColor;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -lh / 2 + 3, w, lh - 6, 6);
      ctx.fill();
      ctx.fillStyle = isDark(st.textColor) ? '#fff' : '#141210';
      ctx.fillText(l, 0, 2, SIZE - 40);
      ctx.restore();
    } else {
      ctx.lineWidth = Math.max(4, size / 7);
      ctx.strokeStyle = '#000';
      ctx.fillStyle = st.textColor;
      ctx.strokeText(l, SIZE / 2, cy, SIZE - 24);
      ctx.fillText(l, SIZE / 2, cy, SIZE - 24);
    }
  });
  ctx.restore();
}

const tmp: Record<string, { c: HTMLCanvasElement; x: CanvasRenderingContext2D }> = {};
function scratch(name: string) {
  if (!tmp[name]) {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    tmp[name] = { c, x: c.getContext('2d')! };
  }
  return tmp[name];
}

/** Draws one sticker frame onto a 512x512 context. */
export function renderFrame(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, st: EditState) {
  if (!st.outline) return drawContent(ctx, src, sw, sh, st);

  // Die-cut look: shrink the artwork, then stamp its silhouette in a ring around it in white.
  const inner = scratch('inner');
  const sil = scratch('sil');
  drawContent(inner.x, src, sw, sh, st);
  const o = st.outline;
  const d = SIZE - 2 * o - 4;
  const off = (SIZE - d) / 2;
  sil.x.globalCompositeOperation = 'source-over';
  sil.x.clearRect(0, 0, SIZE, SIZE);
  for (const r of [o, o * 0.55]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      sil.x.drawImage(inner.c, off + Math.cos(a) * r, off + Math.sin(a) * r, d, d);
    }
  }
  sil.x.globalCompositeOperation = 'source-in';
  sil.x.fillStyle = '#fff';
  sil.x.fillRect(0, 0, SIZE, SIZE);
  sil.x.globalCompositeOperation = 'source-over';

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(sil.c, 0, 0);
  ctx.drawImage(inner.c, off, off, d, d);
}
