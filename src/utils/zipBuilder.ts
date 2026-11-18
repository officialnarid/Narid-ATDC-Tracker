/**
 * Zero-dependency standards-compliant PKZIP (STORE / IEEE CRC-32) archive builder.
 * PNG identity cards are already DEFLATE-compressed inside their IDAT chunks, so STORE mode
 * builds multi-card archives cleanly in milliseconds with identical OS / unzip compatibility.
 */

export interface ZipEntryInput {
  name: string;
  data: Uint8Array | ArrayBuffer | Blob;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

async function normalizeBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    if (typeof data.arrayBuffer === 'function') {
      return new Uint8Array(await data.arrayBuffer());
    }
    return new Uint8Array(await new Response(data).arrayBuffer());
  }
  throw new Error('Unsupported ZIP entry binary payload.');
}

function sanitizeZipEntryName(rawName: string): string {
  const cleaned = String(rawName || 'file.bin')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.\//g, '');
  return cleaned || 'file.bin';
}

export async function createZipUint8Array(entries: ZipEntryInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const now = new Date();
  const { dosTime, dosDate } = toDosTimeDate(now);

  interface PreparedEntry {
    nameBytes: Uint8Array;
    payload: Uint8Array;
    crc32: number;
    offset: number;
  }

  const prepared: PreparedEntry[] = [];
  const usedNames = new Set<string>();
  let localSectionSize = 0;
  let centralDirSize = 0;

  for (const entry of entries) {
    let entryName = sanitizeZipEntryName(entry.name);
    if (usedNames.has(entryName)) {
      const dotIdx = entryName.lastIndexOf('.');
      const stem = dotIdx > 0 ? entryName.slice(0, dotIdx) : entryName;
      const ext = dotIdx > 0 ? entryName.slice(dotIdx) : '';
      let counter = 2;
      while (usedNames.has(`${stem}_${counter}${ext}`)) {
        counter++;
      }
      entryName = `${stem}_${counter}${ext}`;
    }
    usedNames.add(entryName);

    const nameBytes = encoder.encode(entryName);
    const payload = await normalizeBytes(entry.data);
    const crc32 = computeCrc32(payload);

    const offset = localSectionSize;
    localSectionSize += 30 + nameBytes.length + payload.length;
    centralDirSize += 46 + nameBytes.length;

    prepared.push({
      nameBytes,
      payload,
      crc32,
      offset,
    });
  }

  const totalSize = localSectionSize + centralDirSize + 22;
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);

  let cursor = 0;

  // 1. Local File Headers + Payloads
  for (const item of prepared) {
    view.setUint32(cursor, 0x04034b50, true); // Local file header signature
    view.setUint16(cursor + 4, 20, true); // Version needed to extract (2.0)
    view.setUint16(cursor + 6, 0x0800, true); // UTF-8 filename flag (Bit 11)
    view.setUint16(cursor + 8, 0, true); // Compression method 0 = STORE
    view.setUint16(cursor + 10, dosTime, true);
    view.setUint16(cursor + 12, dosDate, true);
    view.setUint32(cursor + 14, item.crc32, true);
    view.setUint32(cursor + 18, item.payload.length, true); // Compressed size
    view.setUint32(cursor + 22, item.payload.length, true); // Uncompressed size
    view.setUint16(cursor + 26, item.nameBytes.length, true);
    view.setUint16(cursor + 28, 0, true); // Extra field length
    output.set(item.nameBytes, cursor + 30);
    cursor += 30 + item.nameBytes.length;

    output.set(item.payload, cursor);
    cursor += item.payload.length;
  }

  const centralDirOffset = cursor;

  // 2. Central Directory File Headers
  for (const item of prepared) {
    view.setUint32(cursor, 0x02014b50, true); // Central directory header signature
    view.setUint16(cursor + 4, 20, true); // Version made by
    view.setUint16(cursor + 6, 20, true); // Version needed
    view.setUint16(cursor + 8, 0x0800, true); // UTF-8 flag
    view.setUint16(cursor + 10, 0, true); // Compression method: STORE
    view.setUint16(cursor + 12, dosTime, true);
    view.setUint16(cursor + 14, dosDate, true);
    view.setUint32(cursor + 16, item.crc32, true);
    view.setUint32(cursor + 20, item.payload.length, true);
    view.setUint32(cursor + 24, item.payload.length, true);
    view.setUint16(cursor + 28, item.nameBytes.length, true);
    view.setUint16(cursor + 30, 0, true); // Extra field length
    view.setUint16(cursor + 32, 0, true); // Comment length
    view.setUint16(cursor + 34, 0, true); // Disk number start
    view.setUint16(cursor + 36, 0, true); // Internal attrs
    view.setUint32(cursor + 38, 0, true); // External attrs
    view.setUint32(cursor + 42, item.offset, true); // Relative offset of local header
    output.set(item.nameBytes, cursor + 46);
    cursor += 46 + item.nameBytes.length;
  }

  // 3. End of Central Directory Record (EOCD)
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 4, 0, true); // Disk number
  view.setUint16(cursor + 6, 0, true); // Central directory start disk
  view.setUint16(cursor + 8, prepared.length, true);
  view.setUint16(cursor + 10, prepared.length, true);
  view.setUint32(cursor + 12, centralDirSize, true);
  view.setUint32(cursor + 16, centralDirOffset, true);
  view.setUint16(cursor + 20, 0, true); // Comment length

  return output;
}

export async function createZipBlob(entries: ZipEntryInput[]): Promise<Blob> {
  const bytes = await createZipUint8Array(entries);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'application/zip' });
}
