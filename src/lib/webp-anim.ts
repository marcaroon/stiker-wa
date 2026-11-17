// Minimal animated-WebP muxer: takes still WebP frames (from canvas or a wasm
// encoder) and wraps their bitstreams in VP8X + ANIM + ANMF chunks.
// Spec: https://developers.google.com/speed/webp/docs/riff_container

interface Chunk {
  fourcc: string;
  data: Uint8Array;
}

function readChunks(buf: Uint8Array): Chunk[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('Bukan file WebP');
  const chunks: Chunk[] = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = tag(off);
    const size = dv.getUint32(off + 4, true);
    chunks.push({ fourcc, data: buf.subarray(off + 8, off + 8 + size) });
    off += 8 + size + (size & 1);
  }
  return chunks;
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  u8(v: number) {
    this.bytes(new Uint8Array([v & 0xff]));
  }
  u16(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >> 8) & 0xff]));
  }
  u24(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]));
  }
  u32(v: number) {
    this.bytes(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]));
  }
  str(s: string) {
    this.bytes(new Uint8Array([...s].map((c) => c.charCodeAt(0))));
  }
  chunk(fourcc: string, payload: Uint8Array) {
    this.str(fourcc);
    this.u32(payload.length);
    this.bytes(payload);
    if (payload.length & 1) this.u8(0);
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export interface AnimFrame {
  webp: Uint8Array;
  /** milliseconds */
  duration: number;
}

export function muxAnimatedWebP(frames: AnimFrame[], width: number, height: number, loop = 0): Uint8Array {
  const body = new ByteWriter();

  // VP8X: alpha + animation flags, canvas size
  const vp8x = new ByteWriter();
  vp8x.u8(0x10 | 0x02);
  vp8x.u24(0);
  vp8x.u24(width - 1);
  vp8x.u24(height - 1);
  body.chunk('VP8X', vp8x.concat());

  // ANIM: transparent background, loop count
  const anim = new ByteWriter();
  anim.u32(0);
  anim.u16(loop);
  body.chunk('ANIM', anim.concat());

  for (const f of frames) {
    const imageChunks = readChunks(f.webp).filter((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L');
    const anmf = new ByteWriter();
    anmf.u24(0); // x / 2
    anmf.u24(0); // y / 2
    anmf.u24(width - 1);
    anmf.u24(height - 1);
    anmf.u24(Math.max(8, Math.round(f.duration)));
    anmf.u8(0x02); // do not blend, no dispose (every frame is a full frame)
    for (const c of imageChunks) anmf.chunk(c.fourcc, c.data);
    body.chunk('ANMF', anmf.concat());
  }

  const file = new ByteWriter();
  file.str('RIFF');
  file.u32(body.length + 4);
  file.str('WEBP');
  file.bytes(body.concat());
  return file.concat();
}
