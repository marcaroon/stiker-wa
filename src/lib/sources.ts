// Media sources: still image, video, or animated image (GIF / animated WebP).
// Every source can hand out a drawable frame for a given time.

export interface Source {
  kind: 'image' | 'video' | 'anim';
  width: number;
  height: number;
  /** seconds; 0 for still images */
  duration: number;
  /** Frame for the live preview (cheap, synchronous). */
  previewFrame(t: number): CanvasImageSource;
  /** Exact frame at time t (used while encoding). */
  frameAt(t: number): Promise<CanvasImageSource>;
  /** For video preview playback. */
  video?: HTMLVideoElement;
  dispose(): void;
}

export async function loadSource(file: Blob): Promise<Source> {
  const type = file.type || '';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test((file as File).name || '')) {
    return loadVideo(file);
  }
  if (type === 'image/gif' || type === 'image/webp' || type === 'image/png' || type === 'image/apng') {
    const anim = await tryLoadAnimated(file).catch(() => null);
    if (anim) return anim;
  }
  return loadImage(file);
}

async function loadImage(file: Blob): Promise<Source> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Fallback (e.g. HEIC on Safari decodes via <img> only)
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error('Format gambar tidak didukung browser ini');
    });
    bmp = await createImageBitmap(img);
    URL.revokeObjectURL(url);
  }
  return {
    kind: 'image',
    width: bmp.width,
    height: bmp.height,
    duration: 0,
    previewFrame: () => bmp,
    frameAt: async () => bmp,
    dispose: () => bmp.close(),
  };
}

async function loadVideo(file: Blob): Promise<Source> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () =>
      rej(new Error('Video tidak bisa diputar di browser ini (codec tidak didukung). Coba format MP4 H.264.'));
  });
  let duration = v.duration;
  if (!isFinite(duration)) {
    // Some recorded webm files report Infinity until you seek far ahead.
    v.currentTime = 1e7;
    await once(v, 'seeked');
    duration = v.duration || v.currentTime;
    v.currentTime = 0;
    await once(v, 'seeked');
  }

  let busy: Promise<unknown> = Promise.resolve();
  const seek = (t: number) => {
    const p = busy.then(async () => {
      t = Math.min(Math.max(0, t), Math.max(0, duration - 0.01));
      if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return v;
      v.currentTime = t;
      await once(v, 'seeked');
      return v;
    });
    busy = p.catch(() => {});
    return p;
  };

  return {
    kind: 'video',
    width: v.videoWidth,
    height: v.videoHeight,
    duration,
    video: v,
    previewFrame: () => v,
    frameAt: (t) => seek(t),
    dispose: () => {
      v.pause();
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    },
  };
}

function once(el: EventTarget, ev: string, timeout = 8000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => {
      el.removeEventListener(ev, h);
      rej(new Error('Timeout saat membaca video'));
    }, timeout);
    const h = () => {
      clearTimeout(t);
      el.removeEventListener(ev, h);
      res();
    };
    el.addEventListener(ev, h);
  });
}

/* ---------- Animated images through WebCodecs ImageDecoder ---------- */

declare const ImageDecoder: any;

async function tryLoadAnimated(file: Blob): Promise<Source | null> {
  if (typeof ImageDecoder === 'undefined') return null;
  const type = file.type;
  if (!(await ImageDecoder.isTypeSupported(type))) return null;
  const dec = new ImageDecoder({ data: file.stream(), type });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  if (!track || !track.animated) {
    dec.close();
    return null;
  }
  await dec.completed;
  const count = Math.min(track.frameCount, 400);
  if (count < 2) {
    dec.close();
    return null;
  }
  const frames: { t: number; bmp: ImageBitmap }[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    const bmp = await createImageBitmap(image);
    // GIF frames with 0 / tiny delays are shown at ~10fps by browsers
    let d = (image.duration ?? 100000) / 1e6;
    if (d < 0.02) d = 0.1;
    frames.push({ t, bmp });
    t += d;
    image.close();
  }
  dec.close();
  const duration = t;
  const at = (time: number) => {
    const tt = ((time % duration) + duration) % duration;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= tt) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo].bmp;
  };
  return {
    kind: 'anim',
    width: frames[0].bmp.width,
    height: frames[0].bmp.height,
    duration,
    previewFrame: at,
    frameAt: async (time) => at(time),
    dispose: () => frames.forEach((f) => f.bmp.close()),
  };
}
