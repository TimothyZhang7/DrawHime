/** 本文件实现浏览器端无压缩 ZIP 打包，用于本地图片切片下载，避免引入额外依赖。 */

/** ZIP 文件条目。 */
export interface ZipStoreEntry {
  /** ZIP 内文件名。 */
  name: string;
  /** 文件二进制内容。 */
  data: Uint8Array;
  /** 文件修改时间。 */
  modifiedAt?: Date;
}

/** 创建 Store 模式 ZIP Blob，适合 PNG/JPEG 这类已压缩图片。 */
export function createStoreZip(entries: ZipStoreEntry[]): Blob {
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const { time, date } = toDosDateTime(entry.modifiedAt ?? new Date());
    const localHeader = createLocalHeader(nameBytes, entry.data.length, crc, time, date);
    fileParts.push(localHeader, nameBytes, entry.data);
    centralParts.push(createCentralHeader(nameBytes, entry.data.length, crc, time, date, offset));
    offset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = createEndRecord(entries.length, centralSize, centralOffset);
  return new Blob([toArrayBuffer([...fileParts, ...centralParts, endRecord])], { type: 'application/zip' });
}

/** 创建本地文件头。 */
function createLocalHeader(nameBytes: Uint8Array, size: number, crc: number, time: number, date: number): Uint8Array {
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  return new Uint8Array(buffer);
}

/** 创建中央目录头。 */
function createCentralHeader(nameBytes: Uint8Array, size: number, crc: number, time: number, date: number, offset: number): Uint8Array {
  const buffer = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(buffer);
  const output = new Uint8Array(buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  output.set(nameBytes, 46);
  return output;
}

/** 创建 ZIP 结束记录。 */
function createEndRecord(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(buffer);
}

/** 将 JS 日期转成 ZIP 使用的 DOS 日期时间字段。 */
function toDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 计算 CRC32，ZIP 中用于校验文件完整性。 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** 合并 ZIP 各段并返回标准 ArrayBuffer，满足 DOM BlobPart 类型约束。 */
function toArrayBuffer(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}
