import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harmonyRoot = path.join(repositoryRoot, 'apps', 'harmony');
const requiredFiles = [
  'AppScope/app.json5',
  'build-profile.example.json5',
  'hvigorfile.ts',
  'oh-package.json5',
  'entry/build-profile.json5',
  'entry/hvigorfile.ts',
  'entry/oh-package.json5',
  'entry/src/main/module.json5',
  'entry/src/main/ets/entryability/EntryAbility.ets',
  'entry/src/main/ets/pages/Index.ets',
  'entry/src/main/resources/base/profile/main_pages.json',
];

for (const relativePath of requiredFiles) await access(path.join(harmonyRoot, relativePath));

const moduleText = await readFile(path.join(harmonyRoot, 'entry/src/main/module.json5'), 'utf8');
const pageText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/Index.ets'), 'utf8');
const abilityText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');

const expectations = [
  [moduleText, 'ohos.permission.INTERNET'],
  [moduleText, '"scheme": "aicenter"'],
  [pageText, "import { webview } from '@kit.ArkWeb'"],
  [pageText, "import { scanBarcode, scanCore } from '@kit.ScanKit'"],
  [pageText, 'preferences.getPreferences'],
  [pageText, 'scanBarcode.startScanForResult'],
  [pageText, 'CONNECTION_TIMEOUT_MS'],
  [pageText, 'pairingConnectionFrom'],
  [pageText, '.onErrorReceive'],
  [abilityText, 'onNewWant'],
];

for (const [source, fragment] of expectations) {
  if (!source.includes(fragment)) throw new Error(`Harmony scaffold is missing: ${fragment}`);
}

console.log(`Harmony scaffold verified (${requiredFiles.length} required files).`);
