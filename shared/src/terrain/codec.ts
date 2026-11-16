// Available in browsers and Node ≥16; declared here because /shared has no DOM lib.
declare function btoa(data: string): string;
declare function atob(data: string): string;

/** Stored heights are multiples of this (Int16 → ±327 world units). */
export const HEIGHT_QUANTUM = 0.01;

export function quantizeHeight(h: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(h / HEIGHT_QUANTUM))) * HEIGHT_QUANTUM;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeHeights(h: Float32Array): string {
  const buf = new ArrayBuffer(h.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < h.length; i++) {
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(h[i]! / HEIGHT_QUANTUM))), true);
  }
  return bytesToBase64(new Uint8Array(buf));
}

export function decodeHeights(b64: string, expected: number): Float32Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== expected * 2) throw new Error(`heights: expected ${expected * 2} bytes, got ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = view.getInt16(i * 2, true) * HEIGHT_QUANTUM;
  return out;
}

export function decodeBytes(b64: string, expected: number, label: string): Uint8Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== expected) throw new Error(`${label}: expected ${expected} bytes, got ${bytes.length}`);
  return bytes;
}
