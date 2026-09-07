import fs from 'node:fs/promises';
import { readXlsx } from '../lib/xlsx.mjs';

/** Current-stage Excel repository. Deliberately has no write implementation. */
export class ReadOnlyExcelRepository {
  async read(filePath) { return readXlsx(await fs.readFile(filePath)); }
  async write() { throw new Error('当前构建禁止 Excel 写入'); }
}
