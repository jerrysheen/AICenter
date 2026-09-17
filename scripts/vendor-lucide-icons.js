import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const names = [
  'plus',
  'search',
  'settings',
  'send-horizontal',
  'arrow-up-down',
  'arrow-up',
  'arrow-down',
  'newspaper',
  'chart-line',
  'layout-grid',
  'message-circle',
  'notebook-text',
  'house',
  'lightbulb',
  'wallet',
  'bookmark',
  'bookmark-check',
  'corner-up-right',
  'refresh-cw',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconRoot = path.join(root, 'node_modules/lucide-static/dist/esm/icons');

function normalize(svg) {
  return svg
    .trim()
    .replace(/\sclass="[^"]*"/, '')
    .replace(/\sxmlns="[^"]*"/, '')
    .replace(/\swidth="24"/, '')
    .replace(/\sheight="24"/, '')
    .replace('stroke-width="2"', 'stroke-width="1.75"')
    .replace('<svg', '<svg aria-hidden="true"')
    .replace(/\n\s+/g, ' ')
    .replace(/\n/g, '');
}

const entries = [];
for (const name of names) {
  const moduleUrl = pathToFileURL(path.join(iconRoot, `${name}.mjs`)).href;
  const imported = await import(moduleUrl);
  entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(normalize(imported.default))}`);
}

const output = `/** Vendored from lucide-static (ISC). Regenerate with \`npm run icons\`. */
const catalog = {
${entries.join(',\n')},
};

export function icon(name) {
  const markup = catalog[name];
  if (!markup) return '';
  return markup;
}
`;

const target = path.join(root, 'apps/web/public/icons.js');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, output);
console.log(`wrote ${names.length} Lucide icons to apps/web/public/icons.js`);
