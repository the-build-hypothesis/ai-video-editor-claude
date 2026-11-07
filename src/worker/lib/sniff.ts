/** Magic-byte sniffing for uploaded media. Pure; operates on the first bytes of a file. */

export type SniffedType = 'mp4' | 'png' | 'jpeg' | 'mp3' | 'wav' | 'webp';

/** Bytes needed to decide (max offset inspected + 1). */
export const SNIFF_BYTES = 12;

const ascii = (b: Uint8Array, off: number, s: string) => {
  if (b.length < off + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
};

export function sniffType(b: Uint8Array): SniffedType | null {
  if (ascii(b, 4, 'ftyp')) return 'mp4';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'wav';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'ID3')) return 'mp3';
  // MPEG audio frame sync: 11 set bits (0xFFE0 mask over the first two bytes).
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** Which sniffed types are acceptable for each declared MIME type. */
const EXPECTED: Record<string, SniffedType[]> = {
  'video/mp4': ['mp4'],
  'image/png': ['png'],
  'image/jpeg': ['jpeg'],
  'image/webp': ['webp'],
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/wave': ['wav'],
};

/** True when the first bytes match the declared MIME type. */
export function matchesMime(head: Uint8Array, mime: string): boolean {
  const allowed = EXPECTED[mime.toLowerCase()];
  if (!allowed) return false;
  const t = sniffType(head);
  return t !== null && allowed.includes(t);
}
