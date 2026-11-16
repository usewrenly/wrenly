/** Passive repository assets are checked as data; no source code or decoder subprocess runs. */
import { createHash } from 'node:crypto';
import { isSourceAsset, sourceFileBytes, REVISION_LIMITS, type RevisionFile, type SourceAsset } from './contracts';
const IMAGE_DIMENSION_LIMIT = 16_384;
const IMAGE_PIXEL_LIMIT = 40_000_000;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= IMAGE_DIMENSION_LIMIT && height <= IMAGE_DIMENSION_LIMIT && width * height <= IMAGE_PIXEL_LIMIT;
}
function validPng(data: Buffer): boolean {
  let offset = 8, chunks = 0, pixels = false;
  while (offset + 12 <= data.length && chunks++ < 10000) {
    const length = data.readUInt32BE(offset);
    if (offset + length + 12 > data.length) return false;
    const tag = data.toString('ascii', offset+4, offset+8);
    if (chunks === 1 && (tag !== 'IHDR' || length !== 13)) return false;
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 255]! ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(offset+8+length)) return false;
    if (tag === 'IDAT') pixels = true;
    if (tag === 'IEND') return length === 0 && pixels && offset + 12 === data.length;
    offset += length + 12;
  }
  return false;
}
function validJpeg(data: Buffer): boolean {
  let offset=2, dimensions=false;
  while (offset < data.length-2) {
    if (data[offset++] !== 255) return false;
    while (data[offset] === 255) offset++;
    const marker=data[offset++];
    if (marker === 0xda) return dimensions;
    if (offset+2 > data.length) return false;
    const length=data.readUInt16BE(offset);
    if (length < 2 || offset+length > data.length) return false;
    if ([0xc0,0xc1,0xc2].includes(marker ?? 0)) {
      if (length < 8 || !validDimensions(data.readUInt16BE(offset+5), data.readUInt16BE(offset+3))) return false;
      dimensions=true;
    }
    offset += length;
  }
  return false;
}
/** Identify bounded native containers. Browser rendering still occurs inside the app's preview boundary. */
function mediaType(path: string, bytes: Uint8Array): string {
  const data = Buffer.from(bytes);
  const suffix = path.split('.').at(-1)?.toLowerCase();
  if (suffix === 'png' && data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii',12,16) === 'IHDR') {
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (validDimensions(width,height) && validPng(data)) return 'image/png';
  }
  if (['jpg','jpeg'].includes(suffix ?? '') && data.length >= 4 && data[0] === 255 && data[1] === 216 && data[data.length-2] === 255 && data[data.length-1] === 217 && validJpeg(data)) return 'image/jpeg';
  if (suffix === 'webp' && data.length >= 20 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) return 'image/webp';
  if (suffix === 'ico' && data.length >= 22 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1) {
    const count = data.readUInt16LE(4);
    if (count > 0 && count <= 256 && 6 + count * 16 <= data.length) {
      for (let i=0;i<count;i++) { const offset=6+i*16; if (data.readUInt32LE(offset+12) < 6+count*16 || data.readUInt32LE(offset+12)+data.readUInt32LE(offset+8)>data.length) throw new Error('Invalid icon asset.'); }
      return 'image/x-icon';
    }
  }
  if (['woff','woff2'].includes(suffix ?? '') && data.length >= (suffix === 'woff' ? 44 : 48) && data.toString('ascii',0,4) === (suffix === 'woff' ? 'wOFF' : 'wOF2') && data.readUInt32BE(8) === data.length && data.readUInt16BE(12) > 0 && data.readUInt16BE(12) <= 4096 && data.readUInt32BE(16) <= REVISION_LIMITS.assetFileBytes) return `font/${suffix}`;
  if (['ttf','otf'].includes(suffix ?? '') && data.length >= 12 && (data.readUInt32BE(0) === 0x00010000 || data.toString('ascii',0,4) === 'OTTO')) {
    const count = data.readUInt16BE(4);
    if (count > 0 && count <= 4096 && 12 + count*16 <= data.length) {
      for (let i=0;i<count;i++) { const offset=12+i*16; if (data.readUInt32BE(offset+8)+data.readUInt32BE(offset+12)>data.length) throw new Error('Invalid font asset.'); }
      return suffix === 'ttf' ? 'font/ttf' : 'font/otf';
    }
  }
  throw new Error('Unsupported or malformed image/font asset.');
}
/** Freeze a verified Git blob as a private immutable object instead of pretending binary bytes are text. */
export function createSourceAsset(path: string, bytes: Uint8Array): SourceAsset {
  if (!bytes.length || bytes.length > REVISION_LIMITS.assetFileBytes) throw new Error('Source asset exceeds its byte limit.');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: mediaType(path,bytes), byteLength: bytes.length, base64: Buffer.from(bytes).toString('base64') };
}
/** Recheck saved objects before every native write, including retries, previews and publishing. */
export function materializeSourceFile(file: RevisionFile): Uint8Array {
  const bytes = sourceFileBytes(file);
  if (file.asset && (!isSourceAsset(file.asset) || createHash('sha256').update(bytes).digest('hex') !== file.asset.sha256 || mediaType(file.path,bytes) !== file.asset.mediaType)) throw new Error('Saved source asset identity could not be verified.');
  return bytes;
}
