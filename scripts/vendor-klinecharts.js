import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules/klinecharts/dist/umd/klinecharts.min.js');
const target = path.join(root, 'apps/web/public/klinecharts.js');

await copyFile(source, target);
console.log('wrote KLineChart 10.0.3 to apps/web/public/klinecharts.js');
