import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { defaultEdit, fontFor, renderFrame, SIZE, type EditState } from './lib/render';
import { loadSource, type Source } from './lib/sources';
import { Cancelled, LIMIT_ANIM, LIMIT_STATIC, MAX_ANIM_SECONDS, makeAnimated, makeStatic, type StickerResult } from './lib/encode';
import { deleteSticker, listStickers, saveSticker, type SavedSticker } from './lib/store';
import { makeZip } from './lib/zip';

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------ state ------------------------------ */
let src: Source | null = null;
let srcToken = 0;
let edit: EditState = defaultEdit();
const vo = { start: 0, length: 3, fps: 12 };
let asStatic = false;
let result: StickerResult | null = null;
let resultUrl = '';
let busy = false; // encoding or building thumbnails: preview loop must not touch the video
let cancelFlag = false;
let dirty = true;

const stage = $<HTMLCanvasElement>('stage');
const sctx = stage.getContext('2d')!;

/* ------------------------------ toast ------------------------------ */
let toastTimer = 0;
function toast(msg: string, ms = 2800) {
  const t = $('toast');
  t.hidden = true;
  void t.offsetWidth; // restart the drop-in animation
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const restartAnim = (el: Element, cls: string) => {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
};

/* ------------------------------ tabs ------------------------------ */
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab as 'make' | 'collection')),
);
document.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.goto as 'make')),
);
function showTab(tab: 'make' | 'collection') {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === tab)),
  );
  $('view-make').hidden = tab !== 'make';
  $('view-collection').hidden = tab !== 'collection';
  if (tab === 'collection') renderCollection();
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* ------------------------------ tools dock ------------------------------ */
function showTool(tool: string) {
  document.querySelectorAll<HTMLButtonElement>('.dock button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tool === tool)),
  );
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tool));
}
document.querySelectorAll<HTMLButtonElement>('.dock button').forEach((b) =>
  b.addEventListener('click', () => showTool(b.dataset.tool!)),
);

/* --------------------------- loading media -------------------------- */
async function openMedia(file: Blob, label?: string) {
  try {
    setLinkStatus('');
    const s = await loadSource(file);
    src?.dispose();
    src = s;
    const token = ++srcToken;
    const keep = { text: edit.text, textColor: edit.textColor, textPos: edit.textPos, textSize: edit.textSize, textFont: edit.textFont, textStyle: edit.textStyle };
    edit = { ...defaultEdit(), ...keep };
    syncControls();

    const moving = s.kind !== 'image';
    $('motion-btn').hidden = !moving;
    $('trim').hidden = !moving;
    if (!moving && document.querySelector('.dock [data-tool="motion"][aria-selected="true"]')) showTool('pos');
    if (moving) {
      vo.start = 0;
      vo.length = Math.min(s.kind === 'anim' ? s.duration : 3, MAX_ANIM_SECONDS, s.duration);
      applyTrim();
    }
    $('src-info').textContent =
      `${label ? label + ' · ' : ''}${s.width}×${s.height}` + (moving ? ` · ${s.duration.toFixed(1)}s` : '');
    $('picker').hidden = true;
    $('editor').hidden = false;
    hideResult();
    dirty = true;
    window.scrollTo({ top: 0 });
    if (moving) {
      await buildStrip(s, token);
      if (token === srcToken && s.video) {
        s.video.currentTime = vo.start;
        s.video.play().catch(() => {});
      }
    }
  } catch (e) {
    setLinkStatus((e as Error).message, true);
  }
}

function setLinkStatus(msg: string, err = false) {
  const el = $('link-status');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('err', err);
}

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) openMedia(f, f.name);
  (e.target as HTMLInputElement).value = '';
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) openMedia(f, f.name);
});
// doodles follow the pointer (parallax)
drop.addEventListener('pointermove', (e) => {
  const r = drop.getBoundingClientRect();
  drop.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
  drop.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
});
drop.addEventListener('pointerleave', () => {
  drop.style.setProperty('--mx', '0');
  drop.style.setProperty('--my', '0');
});

document.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea')) return;
  const f = e.clipboardData?.files?.[0];
  if (f) return openMedia(f, 'clipboard');
  if (extractUrl(e.clipboardData?.getData('text') ?? '')) linkHint();
});

$('reset-src').addEventListener('click', () => {
  src?.dispose();
  src = null;
  srcToken++;
  $('editor').hidden = true;
  $('picker').hidden = false;
  hideResult();
});

/* ------------------------------ links ------------------------------ */
// No server: links can't be downloaded here, so nudge people to save the video first.
function extractUrl(text: string) {
  return text.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? '';
}
function linkHint() {
  toast('link belum bisa langsung — simpan videonya ke galeri dulu, lalu pilih file');
}

/* ----------------------------- controls ----------------------------- */
const NUMERIC = new Set(['radius', 'outline', 'fps']);
function bindSeg(key: string, apply: (v: string) => void) {
  const seg = document.querySelector<HTMLElement>(`.seg[data-key="${key}"]`)!;
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    apply(b.dataset.v!);
    changed();
  });
}
function setSeg(key: string, v: string | number) {
  document
    .querySelectorAll<HTMLButtonElement>(`.seg[data-key="${key}"] button`)
    .forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === String(v))));
}
for (const key of ['fit', 'bg', 'radius', 'outline', 'textPos', 'textFont', 'textStyle'] as const) {
  bindSeg(key, (v) => {
    (edit as any)[key] = NUMERIC.has(key) ? Number(v) : v;
    if (key === 'fit') edit.offX = edit.offY = 0;
    if (key === 'textFont') document.fonts.load(fontFor(edit)).then(() => (dirty = true));
  });
}
bindSeg('fps', (v) => (vo.fps = Number(v)));

function changed() {
  dirty = true;
  updateCutline();
  hideResult();
}

function paintRange(el: HTMLInputElement) {
  const p = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
  el.style.setProperty('--p', `${p}%`);
}
function onInput(id: string, fn: (v: string) => void) {
  $(id).addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    fn(el.value);
    if (el.type === 'range') paintRange(el);
    updateOutputs();
    changed();
  });
}
onInput('zoom', (v) => (edit.zoom = Number(v)));
onInput('text', (v) => (edit.text = v));
onInput('tsize', (v) => (edit.textSize = Number(v)));
$<HTMLInputElement>('as-static').addEventListener('change', (e) => {
  asStatic = (e.target as HTMLInputElement).checked;
  hideResult();
});
$('reset-pos').addEventListener('click', () => {
  edit.offX = edit.offY = 0;
  setZoom(1);
});

$('swatches').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  $('swatches')
    .querySelectorAll('button')
    .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  edit.textColor = b.dataset.c!;
  changed();
});

function updateOutputs() {
  $('zoom-out').textContent = `${edit.zoom.toFixed(1)}×`;
  $('tsize-out').textContent = String(edit.textSize);
}

function syncControls() {
  setSeg('fit', edit.fit);
  setSeg('bg', edit.bg);
  setSeg('radius', edit.radius);
  setSeg('outline', edit.outline);
  setSeg('textPos', edit.textPos);
  setSeg('textFont', edit.textFont);
  setSeg('textStyle', edit.textStyle);
  const z = $<HTMLInputElement>('zoom');
  z.value = String(edit.zoom);
  paintRange(z);
  paintRange($<HTMLInputElement>('tsize'));
  updateOutputs();
  updateCutline();
}

function updateCutline() {
  const r = (Math.min(edit.radius, 256) * 506) / 512;
  const rect = $('cutrect');
  rect.setAttribute('rx', String(r));
  rect.setAttribute('ry', String(r));
}

/* --------------------------- pan & zoom ---------------------------- */
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) pinchDist = dist();
});
stage.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const k = SIZE / stage.clientWidth;
  if (pointers.size === 1) {
    edit.offX += (e.clientX - p.x) * k;
    edit.offY += (e.clientY - p.y) * k;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const d = dist();
    if (pinchDist) setZoom(edit.zoom * (d / pinchDist));
    pinchDist = d;
  }
  changed();
});
['pointerup', 'pointercancel'].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    pointers.delete((e as PointerEvent).pointerId);
    pinchDist = 0;
  }),
);
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    setZoom(edit.zoom * Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);
stage.addEventListener('dblclick', () => {
  edit.offX = edit.offY = 0;
  setZoom(1);
});
function dist() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function setZoom(z: number) {
  edit.zoom = Math.min(4, Math.max(0.3, z));
  const el = $<HTMLInputElement>('zoom');
  el.value = String(edit.zoom);
  paintRange(el);
  updateOutputs();
  changed();
}

/* ------------------------------ trimmer ------------------------------ */
const track = $('track');
const selEl = $('sel');
const MIN_LEN = 0.3;

async function buildStrip(s: Source, token: number) {
  const strip = $('strip');
  strip.replaceChildren();
  const n = Math.max(6, Math.min(14, Math.round(track.clientWidth / 52)));
  busy = true;
  s.video?.pause();
  try {
    for (let i = 0; i < n; i++) {
      if (token !== srcToken) return;
      const frame = await s.frameAt(((i + 0.5) / n) * s.duration);
      const c = document.createElement('canvas');
      c.width = 72;
      c.height = 96;
      const x = c.getContext('2d')!;
      const sc = Math.max(c.width / s.width, c.height / s.height);
      x.drawImage(frame, (c.width - s.width * sc) / 2, (c.height - s.height * sc) / 2, s.width * sc, s.height * sc);
      strip.append(c);
    }
  } catch {
    /* thumbnails are cosmetic */
  } finally {
    if (token === srcToken) busy = false;
  }
}

function applyTrim() {
  if (!src) return;
  const D = src.duration || 1;
  selEl.style.left = `${(vo.start / D) * 100}%`;
  selEl.style.width = `${(vo.length / D) * 100}%`;
  $('sel-len').textContent = `${vo.length.toFixed(1)}s`;
  $('trim-out').textContent = `${vo.start.toFixed(1)}s → ${(vo.start + vo.length).toFixed(1)}s`;
}

let drag: { mode: 'l' | 'r' | 'move'; grab: number } | null = null;
const timeAt = (clientX: number) => {
  const r = track.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (src?.duration ?? 0);
};
track.addEventListener('pointerdown', (e) => {
  if (!src) return;
  const h = (e.target as HTMLElement).closest<HTMLElement>('.h');
  const t = timeAt(e.clientX);
  if (h) drag = { mode: h.dataset.h as 'l' | 'r', grab: 0 };
  else if ((e.target as HTMLElement).closest('.sel')) drag = { mode: 'move', grab: t - vo.start };
  else {
    drag = { mode: 'move', grab: vo.length / 2 };
    moveTrim(e.clientX);
  }
  track.setPointerCapture(e.pointerId);
});
track.addEventListener('pointermove', (e) => drag && moveTrim(e.clientX));
['pointerup', 'pointercancel'].forEach((ev) => track.addEventListener(ev, () => (drag = null)));

function moveTrim(clientX: number) {
  if (!src || !drag) return;
  const D = src.duration;
  const maxLen = Math.min(MAX_ANIM_SECONDS, D);
  const t = timeAt(clientX);
  const end = vo.start + vo.length;
  let seekTo = vo.start;
  if (drag.mode === 'l') {
    const s = Math.min(Math.max(t, end - maxLen, 0), end - MIN_LEN);
    vo.start = s;
    vo.length = end - s;
    seekTo = s;
  } else if (drag.mode === 'r') {
    const e2 = Math.max(Math.min(t, vo.start + maxLen, D), vo.start + MIN_LEN);
    vo.length = e2 - vo.start;
    seekTo = Math.max(vo.start, e2 - 0.4);
  } else {
    vo.start = Math.min(Math.max(0, t - drag.grab), D - vo.length);
    seekTo = vo.start;
  }
  if (src.video && !busy) src.video.currentTime = seekTo;
  applyTrim();
  hideResult();
}

/* ---------------------------- preview loop --------------------------- */
const t0 = performance.now();
const playhead = $('playhead');
function loop() {
  requestAnimationFrame(loop);
  if (!src || busy || $('editor').hidden) return;
  let t = 0;
  if (src.kind === 'image') {
    if (!dirty) return;
    renderFrame(sctx, src.previewFrame(0), src.width, src.height, edit);
  } else if (src.kind === 'video') {
    const v = src.video!;
    const end = Math.min(vo.start + vo.length, src.duration);
    if (asStatic || drag) {
      if (!v.paused) v.pause();
      if (asStatic && !drag && Math.abs(v.currentTime - vo.start) > 0.05 && !v.seeking) v.currentTime = vo.start;
    } else {
      if (v.currentTime >= end - 0.02 || v.currentTime < vo.start - 0.3) v.currentTime = vo.start;
      if (v.paused && !v.seeking) v.play().catch(() => {});
    }
    t = v.currentTime;
    renderFrame(sctx, v, src.width, src.height, edit);
  } else {
    t = asStatic ? vo.start : vo.start + (((performance.now() - t0) / 1000) % Math.max(0.1, vo.length));
    renderFrame(sctx, src.previewFrame(t), src.width, src.height, edit);
  }
  if (src.kind !== 'image') playhead.style.left = `${(t / src.duration) * 100}%`;
  dirty = false;
}
requestAnimationFrame(loop);
document.fonts.ready.then(() => (dirty = true));

/* ------------------------------ encode ------------------------------ */
$('make').addEventListener('click', async () => {
  if (!src || busy) return;
  busy = true;
  cancelFlag = false;
  src.video?.pause();
  hideResult();
  $('make').hidden = true;
  $('progress').hidden = false;
  const bar = $('progress').querySelector<HTMLElement>('.fill i')!;
  const setP = (f: number, label: string) => {
    bar.style.width = `${Math.round(f * 100)}%`;
    $('progress-pct').textContent = `${Math.round(f * 100)}%`;
    $('progress-label').textContent = label;
  };
  setP(0, 'nyiapin…');
  try {
    if (edit.text.trim()) await document.fonts.load(fontFor(edit));
    const animated = src.kind !== 'image' && !asStatic;
    result = animated
      ? await makeAnimated(src, edit, vo, setP, () => cancelFlag)
      : await makeStatic(src, src.kind === 'image' ? 0 : vo.start, edit);
    showResult(result);
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      console.error(e);
      toast(`gagal: ${(e as Error).message}`, 5000);
    }
  } finally {
    busy = false;
    dirty = true;
    $('make').hidden = false;
    $('progress').hidden = true;
    if (src?.video) src.video.currentTime = vo.start;
  }
});
$('cancel').addEventListener('click', () => (cancelFlag = true));

function hideResult() {
  $('result').hidden = true;
}

function showResult(r: StickerResult) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(r.blob);
  const img = $<HTMLImageElement>('result-img');
  img.src = resultUrl;
  const limit = r.animated ? LIMIT_ANIM : LIMIT_STATIC;
  const ok = r.bytes <= limit;
  const badge = $('result-badge');
  badge.innerHTML = `${kb(r.bytes)}<small>${ok ? (r.animated ? 'gerak ✓ lolos' : 'lolos ✓') : 'kegedean ✕'}</small>`;
  badge.classList.toggle('bad', !ok);
  $('result-meta').textContent = r.animated
    ? `animasi ${r.seconds?.toFixed(1)}s · ${r.fps} fps · ${r.frames} frame · kualitas ${Math.round(r.quality * 100)}`
    : `stiker diam · kualitas ${Math.round(r.quality * 100)}`;
  const note = $('result-note');
  note.hidden = !r.note && ok;
  note.textContent = ok ? r.note ?? '' : `melebihi batas WhatsApp (${kb(limit)})`;
  const save = $<HTMLButtonElement>('save');
  save.textContent = '+ Album';
  save.classList.remove('done');
  save.disabled = false;
  $('result').hidden = false;
  restartAnim(img, 'peel');
  restartAnim(badge, 'thunk');
  $('result').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
}

// 3D tilt on the finished sticker
const rstage = $('result-stage');
rstage.addEventListener('pointermove', (e) => {
  const r = rstage.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  const img = $('result-img');
  img.style.setProperty('--ry', `${x * 28}deg`);
  img.style.setProperty('--rx', `${-y * 28}deg`);
});
rstage.addEventListener('pointerleave', () => {
  const img = $('result-img');
  img.style.setProperty('--ry', '0deg');
  img.style.setProperty('--rx', '0deg');
});

const stickerFile = (blob: Blob, i = 0) =>
  new File([blob], `stiker-${Date.now().toString(36)}${i ? '-' + i : ''}.webp`, { type: 'image/webp' });

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function shareFiles(files: File[]) {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast('gagal membagikan: ' + (e as Error).message);
    }
  } else {
    files.forEach((f) => download(f, f.name));
    toast('browser ini nggak bisa share langsung — file diunduh. kirim lewat WA Web ya.', 4500);
  }
}

$('share').addEventListener('click', () => result && shareFiles([stickerFile(result.blob)]));
$('download').addEventListener('click', () => result && download(result.blob, stickerFile(result.blob).name));
$('save').addEventListener('click', async () => {
  if (!result) return;
  const btn = $<HTMLButtonElement>('save');
  btn.disabled = true;
  await saveSticker({ blob: result.blob, animated: result.animated, bytes: result.bytes });
  btn.textContent = 'Masuk album ✓';
  btn.classList.add('done');
  flyToAlbum();
  await updateCount();
});

function flyToAlbum() {
  const img = $<HTMLImageElement>('result-img');
  const tab = $('tab-album');
  const a = img.getBoundingClientRect();
  const b = tab.getBoundingClientRect();
  const done = () => restartAnim(tab, 'bump');
  if (reduceMotion || !img.animate) return done();
  const fly = img.cloneNode() as HTMLImageElement;
  fly.className = 'flyer';
  Object.assign(fly.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.append(fly);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  fly
    .animate(
      [
        { transform: 'translate(0,0) scale(1) rotate(-4deg)' },
        { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 80}px) scale(.6) rotate(140deg)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.08) rotate(340deg)`, opacity: 0.6 },
      ],
      { duration: 750, easing: 'cubic-bezier(.5,0,.6,1)' },
    )
    .finished.then(() => {
      fly.remove();
      done();
    });
}

/* ---------------------------- collection ---------------------------- */
let items: SavedSticker[] = [];
const selected = new Set<string>();
let tileUrls: string[] = [];

async function updateCount() {
  items = await listStickers();
  const c = $('count');
  c.hidden = !items.length;
  c.textContent = String(items.length);
}

function tilt(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 15) - 7) * 1.1;
}

async function renderCollection() {
  await updateCount();
  tileUrls.forEach(URL.revokeObjectURL);
  tileUrls = [];
  for (const id of [...selected]) if (!items.some((s) => s.id === id)) selected.delete(id);
  $('grid').replaceChildren(
    ...items.map((s) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.style.setProperty('--r', `${tilt(s.id)}deg`);
      b.setAttribute('aria-pressed', String(selected.has(s.id)));
      b.setAttribute('aria-label', s.animated ? 'Stiker animasi' : 'Stiker');
      const url = URL.createObjectURL(s.blob);
      tileUrls.push(url);
      b.innerHTML = `<img alt="" src="${url}" loading="lazy">${s.animated ? '<span class="tag">GERAK</span>' : ''}`;
      b.addEventListener('click', () => {
        selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id);
        b.setAttribute('aria-pressed', String(selected.has(s.id)));
        updateSelection();
      });
      return b;
    }),
  );
  $('empty').hidden = items.length > 0;
  $('grid').hidden = !items.length;
  updateSelection();
}

function updateSelection() {
  const n = selected.size;
  $('sel-info').textContent = n ? `${n} dipilih` : items.length ? 'tap buat milih' : '';
  $('sel-all').hidden = !items.length;
  $('sel-all').textContent = n === items.length && n ? 'batal pilih' : 'pilih semua';
  $('selbar').classList.toggle('off', !n);
  $('selbar').hidden = !items.length;
  for (const id of ['del', 'export-zip', 'share-sel']) $<HTMLButtonElement>(id).disabled = !n;
  $<HTMLButtonElement>('export-pack').disabled = n < 3 || n > 30;
}

const selectedItems = () => items.filter((s) => selected.has(s.id));

$('sel-all').addEventListener('click', () => {
  if (selected.size === items.length) selected.clear();
  else items.forEach((s) => selected.add(s.id));
  renderCollection();
});
$('del').addEventListener('click', async () => {
  if (!confirm(`Hapus ${selected.size} stiker dari album?`)) return;
  for (const id of selected) await deleteSticker(id);
  selected.clear();
  renderCollection();
});
$('share-sel').addEventListener('click', () => shareFiles(selectedItems().map((s, i) => stickerFile(s.blob, i + 1))));
$('export-zip').addEventListener('click', async () => {
  const entries = await Promise.all(
    selectedItems().map(async (s, i) => ({ name: `stiker-${i + 1}.webp`, data: new Uint8Array(await s.blob.arrayBuffer()) })),
  );
  download(makeZip(entries), 'stiker.zip');
});
$('export-pack').addEventListener('click', async () => {
  const sel = selectedItems();
  const name = $<HTMLInputElement>('pack-name').value.trim() || 'Stiker Saya';
  const author = $<HTMLInputElement>('pack-author').value.trim() || 'Saya';
  const enc = new TextEncoder();
  const bmp = await createImageBitmap(sel[0].blob);
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  c.getContext('2d')!.drawImage(bmp, 0, 0, 96, 96);
  bmp.close();
  const tray = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  const entries = [
    { name: 'title.txt', data: enc.encode(name) },
    { name: 'author.txt', data: enc.encode(author) },
    { name: 'tray.png', data: new Uint8Array(await tray.arrayBuffer()) },
    ...(await Promise.all(
      sel.map(async (s, i) => ({ name: `${String(i + 1).padStart(2, '0')}.webp`, data: new Uint8Array(await s.blob.arrayBuffer()) })),
    )),
  ];
  const safe = name.replace(/[^\w\- ]+/g, '').trim() || 'stiker';
  download(makeZip(entries), `${safe}.wastickers`);
});

/* ----------------------------- install ------------------------------ */
let installEvt: any = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('install').hidden = true;
});

/* ------------------- incoming shares (Android share sheet) ------------------- */
async function handleIncomingShare() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) {
    const url = extractUrl([params.get('url'), params.get('text'), params.get('title')].join(' '));
    if (url) {
      history.replaceState(null, '', '/');
      linkHint();
    }
    return;
  }
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('share-inbox');
    const metaRes = await cache.match('/_share/meta');
    const fileRes = await cache.match('/_share/file');
    await cache.delete('/_share/meta');
    await cache.delete('/_share/file');
    const meta = metaRes ? await metaRes.json() : {};
    if (fileRes) {
      const blob = await fileRes.blob();
      return openMedia(new File([blob], meta.fileName || 'shared', { type: blob.type || meta.fileType }), 'dibagikan');
    }
    const url = extractUrl([meta.url, meta.text, meta.title].filter(Boolean).join(' '));
    if (url) linkHint();
    else toast('nggak ada media yang bisa dipakai');
  } catch (e) {
    console.error(e);
  }
}

syncControls();
updateCount();
handleIncomingShare();
