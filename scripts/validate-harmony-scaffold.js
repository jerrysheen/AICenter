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
  'entry/src/main/ets/shareability/ShareExtensionAbility.ets',
  'entry/src/main/ets/pages/Index.ets',
  'entry/src/main/ets/pages/Share.ets',
  'entry/src/main/ets/pages/LocalInspiration.ets',
  'entry/src/main/ets/storage/LocalInspirationStore.ets',
  'entry/src/main/resources/base/profile/main_pages.json',
];

for (const relativePath of requiredFiles) await access(path.join(harmonyRoot, relativePath));

const moduleText = await readFile(path.join(harmonyRoot, 'entry/src/main/module.json5'), 'utf8');
const pageText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/Index.ets'), 'utf8');
const abilityText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
const shareAbilityText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/shareability/ShareExtensionAbility.ets'), 'utf8');
const sharePageText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/Share.ets'), 'utf8');
const localPageText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/LocalInspiration.ets'), 'utf8');
const localStoreText = await readFile(path.join(harmonyRoot, 'entry/src/main/ets/storage/LocalInspirationStore.ets'), 'utf8');

const expectations = [
  [moduleText, 'ohos.permission.INTERNET'],
  [moduleText, '"scheme": "aicenter"'],
  [moduleText, '"type": "share"'],
  [moduleText, 'ohos.want.action.sendData'],
  [moduleText, 'general.text'],
  [moduleText, 'general.hyperlink'],
  [pageText, "import { http } from '@kit.NetworkKit'"],
  [pageText, "import { webview } from '@kit.ArkWeb'"],
  [pageText, "import { scanBarcode, scanCore } from '@kit.ScanKit'"],
  [pageText, "inputConsumer, KeyCode, KeyEvent as InputKeyEvent"],
  [pageText, 'preferences.getPreferences'],
  [pageText, 'scanBarcode.startScanForResult'],
  [pageText, 'LAN_PROBE_TIMEOUT_MS'],
  [pageText, 'WAN_PROBE_TIMEOUT_MS'],
  [pageText, 'probeServer'],
  [pageText, '/api/v1/health'],
  [pageText, 'saveCookieAsync'],
  [pageText, 'rememberServer'],
  [pageText, 'interface ShellWebInterceptEvent'],
  [pageText, 'interface ShellWebErrorEvent'],
  [pageText, 'pairingConnectionFrom'],
  [pageText, "RESET_CONNECTION_URI = 'aicenter://reset'"],
  [pageText, ".javaScriptProxy({"],
  [pageText, "name: 'AICenterShell'"],
  [pageText, 'openExternalUrl'],
  [pageText, 'ohos.want.action.viewData'],
  [pageText, 'getLocalInspirationOutbox'],
  [moduleText, '"querySchemes"'],
  [pageText, 'AICenterSyncLocalInspirations'],
  [pageText, "url: 'pages/LocalInspiration'"],
  [pageText, 'KEYCODE_FINGERPRINT_SLIDE_UP'],
  [pageText, 'KEYCODE_FINGERPRINT_SLIDE_DOWN'],
  [pageText, "inputConsumer.on('keyPressed'"],
  [pageText, 'SMART_CONTROL_SCROLL_FRICTION'],
  [pageText, 'controller.scrollBy'],
  [pageText, '.onLoadIntercept'],
  [pageText, '.onErrorReceive'],
  [abilityText, 'onNewWant'],
  [shareAbilityText, 'systemShare.getSharedData(want)'],
  [shareAbilityText, "record.content"],
  [sharePageText, 'LocalInspirationStore'],
  [sharePageText, "captureChannel: 'harmony-share'"],
  [sharePageText, 'await this.store.create'],
  [localPageText, "captureChannel: 'harmony-local'"],
  [localPageText, 'this.store.delete'],
  [localStoreText, "type LocalSyncState = 'pending' | 'synced' | 'delete-pending' | 'error'"],
  [localStoreText, 'relationalStore.getRdbStore'],
  [localStoreText, 'local_inspiration_state'],
  [localStoreText, 'migrateLegacyPreferences'],
  [localStoreText, 'clientMutationId'],
  [localStoreText, 'contentKey(item.body, item.sourceUrl)'],
];

for (const [source, fragment] of expectations) {
  if (!source.includes(fragment)) throw new Error(`Harmony scaffold is missing: ${fragment}`);
}

console.log(`Harmony scaffold verified (${requiredFiles.length} required files).`);
