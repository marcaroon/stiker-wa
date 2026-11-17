import { muxAnimatedWebP, type AnimFrame } from './webp-anim';
import { renderFrame, SIZE, type EditState } from './render';
import type { Source } from './sources';

// WhatsApp sticker limits
export const LIMIT_STATIC = 100 * 1024;
export const LIMIT_ANIM = 500 * 1024;
export const MAX_ANIM_SECONDS = 10;

let nativeSupport: boolean | undefined;
function nativeWebp() {
  if (nativeSupport === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    nativeSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return nativeSupport;
}

let jsquash: Promise<typeof import('@jsquash/webp/encode.js')> | null = null;

/** Encode a canvas to a still WebP (native encoder when available, wasm otherwise — e.g. Safari). */
export async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  if (nativeWebp()) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality));
    if (blob && blob.type === 'image/webp') return new Uint8Array(await blob.arrayBuffer());
  }
  jsquash ??= import('@jsquash/webp/encode.js');
  const { default: encode } = await jsquash;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  return new Uint8Array(await encode(data, { quality: Math.round(quality * 100) }));
}

export interface VideoOpts {
  start: number;
  length: number;
  fps: number;
}

export interface StickerResult {
  blob: Blob;
  animated: boolean;
  bytes: number;
  quality: number;
  fps?: number;
  frames?: number;
  seconds?: number;
  note?: string;
}

export type Progress = (fraction: number, label: string) => void;

export class Cancelled extends Error {
  constructor() {
    super('Dibatalkan');
  }
}

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: !nativeWebp() })!;
  return { c, ctx };
}

const STATIC_Q = [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.15, 0.08];
const ANIM_Q = [0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22, 0.16, 0.1, 0.05];

export async function makeStatic(src: Source, t: number, st: EditState): Promise<StickerResult> {
  const { c, ctx } = makeCanvas();
  renderFrame(ctx, await src.frameAt(t), src.width, src.height, st);
  let bytes: Uint8Array = new Uint8Array();
  let q = STATIC_Q[0];
  for (q of STATIC_Q) {
    bytes = await encodeCanvas(c, q);
    if (bytes.length <= LIMIT_STATIC) break;
  }
  return {
    blob: new Blob([bytes as BlobPart], { type: 'image/webp' }),
    animated: false,
    bytes: bytes.length,
    quality: q,
  };
}

function frameTimes(start: number, length: number, fps: number) {
  const n = Math.max(2, Math.round(length * fps));
  return Array.from({ length: n }, (_, i) => start + i / fps);
}

function durations(n: number, fps: number) {
  return Array.from({ length: n }, (_, i) => Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps));
}

export async function makeAnimated(
  src: Source,
  st: EditState,
  vo: VideoOpts,
  onProgress: Progress,
  isCancelled: () => boolean = () => false,
): Promise<StickerResult> {
  const check = () => {
    if (isCancelled()) throw new Cancelled();
  };
  const { c, ctx } = makeCanvas();
  const renderAt = async (t: number) => {
    renderFrame(ctx, await src.frameAt(t), src.width, src.height, st);
  };

  let start = Math.max(0, vo.start);
  let length = Math.min(vo.length, MAX_ANIM_SECONDS, src.kind === 'video' ? src.duration - start : MAX_ANIM_SECONDS);
  if (src.kind === 'anim') length = Math.min(length, src.duration);
  length = Math.max(0.2, length);
  let fps = vo.fps;
  const target = LIMIT_ANIM * 0.9;
  let note: string | undefined;

  // --- 1. Estimate quality from a handful of sample frames ---
  onProgress(0, 'Menganalisis video…');
  const sampleTimes = Array.from({ length: 6 }, (_, i) => start + (length * (i + 0.5)) / 6);
  const samples: HTMLCanvasElement[] = [];
  for (const t of sampleTimes) {
    check();
    await renderAt(t);
    const s = document.createElement('canvas');
    s.width = s.height = SIZE;
    s.getContext('2d')!.drawImage(c, 0, 0);
    samples.push(s);
  }
  const avgAt = new Map<number, number>();
  const avg = async (q: number) => {
    if (!avgAt.has(q)) {
      let sum = 0;
      for (const s of samples) sum += (await encodeCanvas(s, q)).length;
      avgAt.set(q, sum / samples.length);
    }
    return avgAt.get(q)!;
  };
  const estimate = async (q: number, n: number) => (await avg(q)) * n + n * 26 + 64;

  let qi = -1;
  const fpsSteps = [fps, ...[12, 10, 8].filter((f) => f < fps)];
  // Pass 1: keep quality decent (≥ 0.35) and drop FPS first; pass 2: allow any quality.
  search: for (const minQ of [0.35, 0]) {
    for (const f of fpsSteps) {
      check();
      const n = frameTimes(start, length, f).length;
      for (let i = 0; i < ANIM_Q.length && ANIM_Q[i] >= minQ; i++) {
        onProgress(0.02 + (0.08 * i) / ANIM_Q.length, 'Mencari kualitas terbaik…');
        if ((await estimate(ANIM_Q[i], n)) <= target) {
          qi = i;
          if (f !== fps) note = `FPS diturunkan ke ${f} supaya kualitas tetap bagus & muat di bawah 500 KB`;
          fps = f;
          break search;
        }
      }
    }
  }
  if (qi < 0) {
    // Even the lowest settings are too big: shorten the clip.
    qi = ANIM_Q.length - 1;
    fps = fpsSteps[fpsSteps.length - 1];
    const perSecond = await estimate(ANIM_Q[qi], fps); // ~bytes per second of clip
    const newLen = Math.max(0.5, Math.floor((target / perSecond) * 10) / 10);
    note = `Durasi dipotong jadi ${newLen.toFixed(1)} detik supaya muat di bawah 500 KB`;
    length = Math.min(length, newLen);
  }

  // --- 2. Full encode, stepping quality down if we still overshoot ---
  for (let attempt = 0; attempt < 4; attempt++) {
    const q = ANIM_Q[qi];
    const times = frameTimes(start, length, fps);
    const durs = durations(times.length, fps);
    const frames: AnimFrame[] = [];
    let total = 0;
    for (let i = 0; i < times.length; i++) {
      check();
      await renderAt(times[i]);
      const webp = await encodeCanvas(c, q);
      total += webp.length;
      frames.push({ webp, duration: durs[i] });
      onProgress(0.1 + (0.9 * (i + 1)) / times.length, `Encode frame ${i + 1}/${times.length}`);
      if (total > LIMIT_ANIM * 1.05) break; // hopeless at this quality, bail early
    }
    if (frames.length === times.length) {
      const out = muxAnimatedWebP(frames, SIZE, SIZE);
      if (out.length <= LIMIT_ANIM) {
        if (q < 0.3) note = `${note ? note + '. ' : ''}Video ini sangat detail — pakai durasi lebih pendek supaya kualitas lebih tajam.`;
        return {
          blob: new Blob([out as BlobPart], { type: 'image/webp' }),
          animated: true,
          bytes: out.length,
          quality: q,
          fps,
          frames: frames.length,
          seconds: length,
          note,
        };
      }
    }
    if (qi < ANIM_Q.length - 1) qi = Math.min(ANIM_Q.length - 1, qi + 2);
    else if (fps > 8) fps = Math.max(8, fps - 4);
    else length = Math.max(0.5, length * 0.7);
    note = 'Kualitas/durasi diturunkan supaya muat di bawah 500 KB';
  }
  throw new Error('Gagal mengecilkan stiker di bawah 500 KB. Coba durasi lebih pendek.');
}
