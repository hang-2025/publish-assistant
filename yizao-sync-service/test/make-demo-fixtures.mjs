import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 生成阶段1A 演示夹具（用于人工验收截图），写到指定目录。
 * 用法：node test/make-demo-fixtures.mjs <目标根目录>
 * 只创建新目录与新文件，不触碰任何真实文章目录。
 */

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(seed, w = 64, h = 48) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(w * 3).map((_, i) => ((seed * 7 + y * 13 + i) & 0xff)),
  ])));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

async function makePackage(dir, { images, alts, htmlImgs }) {
  await fs.mkdir(path.join(dir, '06-发布图片'), { recursive: true });
  await fs.writeFile(path.join(dir, '01-SEO信息.txt'), `内容栏目：${path.basename(path.dirname(dir))}\n内容标题：${path.basename(dir)}\nSEO标题：${path.basename(dir)}\nSEO关键字：浪涌保护器、智能防雷\nSEO描述：演示夹具：阶段1A 只读原型验收。\n`);
  await fs.writeFile(path.join(dir, '03-图片ALT清单.txt'), alts.map((a, i) => `${i + 1}-图.png：${a}`).join('\n'));
  const body = htmlImgs.map((n, i) => `<p>第${i + 1}段正文：这是阶段1A 演示夹具，用于只读扫描与预览验收。</p><img src="06-发布图片/${n}" alt="">`).join('\n') + '\n<p>结尾段落。</p>';
  await fs.writeFile(path.join(dir, '02-后台一键复制正文.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
  for (const [name, seed] of images) await fs.writeFile(path.join(dir, '06-发布图片', name), makePng(seed));
}

const root = process.argv[2];
if (!root) { console.error('用法：node test/make-demo-fixtures.mjs <目标根目录>'); process.exit(1); }
const unpublish = path.join(root, '未发布');
await makePackage(path.join(unpublish, '官网', 'eyzao.com', '浪涌保护器', '2026-09-01', '电源浪涌保护器的选型与安装要点'), {
  images: [['1-浪涌保护器安装.png', 1], ['2-接线示意图.png', 2], ['3-产品细节.png', 3]],
  alts: ['电源浪涌保护器安装位置示意', '浪涌保护器接线示意图', '浪涌保护器产品细节图'],
  htmlImgs: ['1-浪涌保护器安装.png', '2-接线示意图.png', '3-产品细节.png'],
});
await makePackage(path.join(unpublish, '主流平台', 'zhihu', '智能雷暴仪', '2026-09-02', '智能雷暴仪在雷电预警系统中的应用'), {
  images: [['1-雷暴仪.png', 4], ['2-预警平台.png', 5]],
  alts: ['智能雷暴仪设备图', '雷电预警平台界面'],
  htmlImgs: ['1-雷暴仪.png', '2-预警平台.png'],
});
console.log(`演示夹具已生成：${unpublish}`);
