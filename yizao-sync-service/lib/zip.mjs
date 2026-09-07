import zlib from 'node:zlib';

/**
 * 最小 ZIP 读写（无第三方依赖）。
 *
 * 目的：阶段1B 只对「新建的模拟 .xlsx 夹具」做只读映射。.xlsx 本质是 ZIP 容器，
 * 需要一个不依赖网络/原生模块的实现才能在干净电脑上安装使用。
 * - 写入：store（不压缩），结构简单可靠，用于生成测试夹具；
 * - 读取：支持 method 0（store）与 method 8（deflate，兼容真实 Excel 导出的 .xlsx，
 *   后续获得授权读取真实登记表时可直接复用本解析器）。
 * - 内置 CRC32、大小上限与条目数量防护，拒绝 zip 炸弹。
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
export const MAX_ZIP_ENTRIES = 256;
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function uint16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function uint32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/**
 * 写入一个 store 模式的 zip。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @returns {Buffer}
 */
export function zipStore(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ZIP_ENTRIES) throw new Error('zip 条目数量超限');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      uint16(20), uint16(0), uint16(0),
      uint16(0), uint16(0),
      uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0),
      name,
    ]);
    parts.push(local, data);
    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      uint16(20), uint16(20), uint16(0), uint16(0),
      uint16(0), uint16(0),
      uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0), uint16(0), uint16(0),
      uint16(0), uint32(0),
      uint32(offset),
      name,
    ]);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDir.length), uint32(offset),
    uint16(0),
  ]);
  return Buffer.concat([...parts, centralDir, end]);
}

/** 从 buffer 末尾向前定位 EOCD（兼容末尾带注释的情况）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/**
 * 读取 zip，返回 { name: data(Buffer) } 映射。防御：条目数量、单条与总大小上限。
 * @param {Buffer} buf
 */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（缺少目录记录）');
  const total = buf.readUInt16LE(eocd + 10);
  if (total === 0 || total > MAX_ZIP_ENTRIES) throw new Error('zip 条目数量超限');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_HEADER) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (compSize > MAX_ZIP_ENTRY_BYTES || uncompSize > MAX_ZIP_ENTRY_BYTES) throw new Error('zip 条目过大');
    // 定位本地头之后的数据
    const lh = localOffset;
    if (buf.readUInt32LE(lh) !== LOCAL_HEADER) throw new Error('zip 本地头损坏');
    const lNameLen = buf.readUInt16LE(lh + 26);
    const lExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式：${method}`);
    if (data.length !== uncompSize) throw new Error(`zip 条目解压长度不一致：${name}`);
    if (crc32(data) !== buf.readUInt32LE(p + 16)) throw new Error(`zip 条目校验失败：${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
