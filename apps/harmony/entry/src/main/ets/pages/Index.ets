import { common, Want } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { inputConsumer, KeyCode, KeyEvent as InputKeyEvent } from '@kit.InputKit';
import { http } from '@kit.NetworkKit';
import { webview } from '@kit.ArkWeb';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { LocalInspirationStore } from '../storage/LocalInspirationStore';

const PREFERENCE_FILE = 'ai_center_connection';
const SERVER_URL_KEY = 'server_url';
const SHELL_UA = ' AI-Center-Harmony/0.2';
const LAN_PROBE_TIMEOUT_MS = 2500;
const WAN_PROBE_TIMEOUT_MS = 5000;
const RESET_CONNECTION_URI = 'aicenter://reset';
const SMART_CONTROL_SCROLL_INITIAL_VELOCITY_VP_MS = 1.6;
const SMART_CONTROL_SCROLL_FRAME_MS = 16;
const SMART_CONTROL_SCROLL_FRICTION = 0.92;
const SMART_CONTROL_SCROLL_MIN_VELOCITY_VP_MS = 0.08;

enum ShellStatus {
  SETUP,
  CHECKING,
  READY,
  ERROR,
}

interface ShellWebRequest {
  getRequestUrl(): string;
}

interface ShellWebFrameRequest {
  isMainFrame(): boolean;
}

interface ShellWebInterceptEvent {
  data: ShellWebRequest;
}

interface ShellWebErrorEvent {
  request: ShellWebFrameRequest;
}

class ConnectionTarget {
  serverUrl: string = '';
  pageUrl: string = '';
  valid: boolean = false;

  constructor(serverUrl: string, pageUrl: string, valid: boolean) {
    this.serverUrl = serverUrl;
    this.pageUrl = pageUrl;
    this.valid = valid;
  }
}

class ProbeResult {
  online: boolean = false;
  uiRevision: string = '';

  constructor(online: boolean, uiRevision: string) {
    this.online = online;
    this.uiRevision = uiRevision;
  }
}

function withUiRevision(pageUrl: string, revision: string): string {
  if (!revision || !pageUrl) return pageUrl;
  const hashIndex = pageUrl.indexOf('#');
  const hash = hashIndex >= 0 ? pageUrl.substring(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? pageUrl.substring(0, hashIndex) : pageUrl;
  if (beforeHash.indexOf('v=') >= 0 && (beforeHash.indexOf('?v=') >= 0 || beforeHash.indexOf('&v=') >= 0)) {
    return beforeHash.replace(/([?&]v=)[^&#]*/, `$1${revision}`) + hash;
  }
  const sep = beforeHash.indexOf('?') >= 0 ? '&' : '?';
  return `${beforeHash}${sep}v=${revision}${hash}`;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function isAppUrl(url: string, serverUrl: string): boolean {
  const origin = serverUrl.replace(/\/+$/, '');
  if (!origin) return false;
  return url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`) || url.startsWith(`${origin}#`);
}

class ShellBridge {
  private resetHandler: () => void;
  private localStore: LocalInspirationStore;
  private openUrlHandler: (url: string) => void;

  constructor(
    resetHandler: () => void,
    localStore: LocalInspirationStore,
    openUrlHandler: (url: string) => void,
  ) {
    this.resetHandler = resetHandler;
    this.localStore = localStore;
    this.openUrlHandler = openUrlHandler;
  }

  resetConnection(): void {
    this.resetHandler();
  }

  openExternalUrl(url: string): void {
    this.openUrlHandler(url);
  }

  getLocalInspirationOutbox(): string {
    return this.localStore.getOutboxJson();
  }

  acknowledgeLocalInspiration(clientMutationId: string, serverId: string): void {
    this.localStore.acknowledge(clientMutationId, serverId);
  }

  markLocalInspirationError(clientMutationId: string, message: string): void {
    this.localStore.markError(clientMutationId, message);
  }

}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
  } catch (_error) {
    return '';
  }
}

function queryValue(uri: string, key: string): string {
  const queryIndex = uri.indexOf('?');
  if (queryIndex < 0) return '';
  const parts = uri.slice(queryIndex + 1).split('&');
  for (const part of parts) {
    const separator = part.indexOf('=');
    const rawKey = separator >= 0 ? part.slice(0, separator) : part;
    if (decodeQueryPart(rawKey) !== key) continue;
    return decodeQueryPart(separator >= 0 ? part.slice(separator + 1) : '');
  }
  return '';
}

function normalizeServer(value: string): string {
  const withoutQuery = value.trim().split('?')[0].replace(/\/+$/, '');
  if (!withoutQuery.startsWith('http://') && !withoutQuery.startsWith('https://')) return '';
  if (withoutQuery.length < 10 || withoutQuery.includes(' ')) return '';
  return withoutQuery;
}

function connectionFrom(value: string): ConnectionTarget {
  const trimmed = value.trim();
  if (trimmed.startsWith('aicenter://pair')) {
    const server = normalizeServer(queryValue(trimmed, 'server'));
    const code = queryValue(trimmed, 'code');
    const pageUrl = server && code ? `${server}/?pair=${encodeURIComponent(code)}` : '';
    return new ConnectionTarget(server, pageUrl, Boolean(server && code));
  }
  const server = normalizeServer(trimmed);
  const code = queryValue(trimmed, 'pair');
  const pageUrl = server ? (code ? `${server}/?pair=${encodeURIComponent(code)}` : server) : '';
  return new ConnectionTarget(server, pageUrl, Boolean(server));
}

function pairingConnectionFrom(value: string): ConnectionTarget {
  const trimmed = value.trim();
  const isAppPairing = trimmed.startsWith('aicenter://pair');
  const isWebPairing = (trimmed.startsWith('http://') || trimmed.startsWith('https://')) &&
    Boolean(queryValue(trimmed, 'pair'));
  if (!isAppPairing && !isWebPairing) return new ConnectionTarget('', '', false);
  return connectionFrom(trimmed);
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private localStore: LocalInspirationStore = new LocalInspirationStore();
  private shellBridge: ShellBridge = new ShellBridge(() => {
    this.returnToSetup('已退出当前连接，请扫描新的二维码。');
  }, this.localStore, (url: string) => this.openInSystemBrowser(url));
  private preferenceStore: preferences.Preferences | null = null;
  private probeGeneration: number = 0;
  private slideUpSubscribed: boolean = false;
  private slideDownSubscribed: boolean = false;
  private scrollAnimationTimeoutId: number = -1;
  private scrollVelocityY: number = 0;
  private slideUpHandler = (_event: InputKeyEvent): void => {
    this.startWebInertia(-SMART_CONTROL_SCROLL_INITIAL_VELOCITY_VP_MS);
  };
  private slideDownHandler = (_event: InputKeyEvent): void => {
    this.startWebInertia(SMART_CONTROL_SCROLL_INITIAL_VELOCITY_VP_MS);
  };
  @StorageLink('launchUri') @Watch('onLaunchUriChanged') launchUri: string = '';
  @StorageLink('localInspirationRefreshVersion') @Watch('onLocalInspirationRefresh')
  localInspirationRefreshVersion: number = 0;
  @State serverInput: string = '';
  @State serverUrl: string = '';
  @State pageUrl: string = '';
  @State shellStatus: ShellStatus = ShellStatus.SETUP;
  @State errorMessage: string = '';
  @State isScanning: boolean = false;

  aboutToAppear(): void {
    this.subscribeSmartControlKey();
    this.restoreConnection();
  }

  aboutToDisappear(): void {
    this.unsubscribeSmartControlKey();
    this.stopWebInertia();
    this.persistWebSession();
    this.probeGeneration += 1;
  }

  onBackPress(): boolean {
    try {
      if (this.shellStatus === ShellStatus.READY && this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (_error) {
      return false;
    }
    return false;
  }

  private getAbilityContext(): common.UIAbilityContext {
    const context = this.getUIContext().getHostContext();
    if (!context) throw new Error('无法获取应用上下文');
    return context as common.UIAbilityContext;
  }

  private subscribeSmartControlKey(): void {
    try {
      inputConsumer.on('keyPressed', {
        key: KeyCode.KEYCODE_FINGERPRINT_SLIDE_UP,
        action: 1,
        isRepeat: false,
      }, this.slideUpHandler);
      this.slideUpSubscribed = true;
    } catch (_error) {
      this.slideUpSubscribed = false;
    }

    try {
      inputConsumer.on('keyPressed', {
        key: KeyCode.KEYCODE_FINGERPRINT_SLIDE_DOWN,
        action: 1,
        isRepeat: false,
      }, this.slideDownHandler);
      this.slideDownSubscribed = true;
    } catch (_error) {
      this.slideDownSubscribed = false;
    }
  }

  private unsubscribeSmartControlKey(): void {
    if (this.slideUpSubscribed) {
      try {
        inputConsumer.off('keyPressed', this.slideUpHandler);
      } catch (_error) {
        // 生命周期退出时即使系统已回收订阅，也不影响应用关闭。
      }
      this.slideUpSubscribed = false;
    }

    if (this.slideDownSubscribed) {
      try {
        inputConsumer.off('keyPressed', this.slideDownHandler);
      } catch (_error) {
        // 生命周期退出时即使系统已回收订阅，也不影响应用关闭。
      }
      this.slideDownSubscribed = false;
    }
  }

  private startWebInertia(velocityY: number): void {
    if (this.shellStatus !== ShellStatus.READY) return;
    this.scrollVelocityY = velocityY;
    if (this.scrollAnimationTimeoutId < 0) this.runWebInertiaFrame();
  }

  private runWebInertiaFrame(): void {
    if (this.shellStatus !== ShellStatus.READY ||
      Math.abs(this.scrollVelocityY) < SMART_CONTROL_SCROLL_MIN_VELOCITY_VP_MS) {
      this.stopWebInertia();
      return;
    }

    try {
      this.controller.scrollBy(0, this.scrollVelocityY * SMART_CONTROL_SCROLL_FRAME_MS);
    } catch (_error) {
      this.stopWebInertia();
      return;
    }

    this.scrollVelocityY *= SMART_CONTROL_SCROLL_FRICTION;
    this.scrollAnimationTimeoutId = setTimeout(() => this.runWebInertiaFrame(), SMART_CONTROL_SCROLL_FRAME_MS);
  }

  private stopWebInertia(): void {
    if (this.scrollAnimationTimeoutId >= 0) clearTimeout(this.scrollAnimationTimeoutId);
    this.scrollAnimationTimeoutId = -1;
    this.scrollVelocityY = 0;
  }

  private persistWebSession(): void {
    try {
      webview.WebCookieManager.putAcceptCookieEnabled(true);
      webview.WebCookieManager.saveCookieAsync().then(() => {}, () => {});
    } catch (_error) {
      // Cookie 仍由 ArkWeb 自行管理；显式落盘失败不阻断页面。
    }
  }

  private probeTimeoutMs(serverUrl: string): number {
    return serverUrl.startsWith('https://') ? WAN_PROBE_TIMEOUT_MS : LAN_PROBE_TIMEOUT_MS;
  }

  private async probeServer(serverUrl: string): Promise<ProbeResult> {
    const timeout = this.probeTimeoutMs(serverUrl);
    const client = http.createHttp();
    try {
      const response = await client.request(`${serverUrl}/api/v1/health`, {
        method: http.RequestMethod.GET,
        connectTimeout: timeout,
        readTimeout: timeout,
        expectDataType: http.HttpDataType.STRING,
        header: { 'Accept': 'application/json' },
      });
      const online = Boolean(response && response.responseCode > 0 && response.responseCode < 600);
      let uiRevision = '';
      if (online && typeof response.result === 'string') {
        try {
          const payload = JSON.parse(response.result) as Record<string, Object>;
          if (typeof payload.uiRevision === 'string') uiRevision = payload.uiRevision;
        } catch (_error) {
          uiRevision = '';
        }
      }
      return new ProbeResult(online, uiRevision);
    } catch (_error) {
      return new ProbeResult(false, '');
    } finally {
      try {
        client.destroy();
      } catch (_error) {
        // 探测结束后释放连接即可。
      }
    }
  }

  private async rememberServer(serverUrl: string): Promise<void> {
    if (!this.preferenceStore) return;
    try {
      await this.preferenceStore.put(SERVER_URL_KEY, serverUrl);
      await this.preferenceStore.flush();
    } catch (_error) {
      // 连接本身仍可继续；下一次成功扫码会再次尝试保存。
    }
  }

  private async restoreConnection(): Promise<void> {
    try {
      const context = this.getAbilityContext();
      await this.localStore.initialize(context);
      this.preferenceStore = await preferences.getPreferences(context, PREFERENCE_FILE);
      const stored = await this.preferenceStore.get(SERVER_URL_KEY, '') as string;
      const launchTarget = connectionFrom(this.launchUri);
      if (launchTarget.valid) {
        await this.openTarget(launchTarget);
        return;
      }
      const storedTarget = connectionFrom(stored);
      if (storedTarget.valid) {
        await this.openTarget(storedTarget);
        return;
      }
      this.shellStatus = ShellStatus.SETUP;
    } catch (error) {
      const businessError = error as BusinessError;
      this.errorMessage = businessError.message || '无法读取本地连接设置';
      this.shellStatus = ShellStatus.ERROR;
    }
  }

  private async onLaunchUriChanged(): Promise<void> {
    const target = connectionFrom(this.launchUri);
    if (target.valid) await this.openTarget(target);
  }

  private async onLocalInspirationRefresh(): Promise<void> {
    await this.localStore.reload();
    if (this.shellStatus === ShellStatus.READY) {
      this.controller.runJavaScript(
        'window.AICenterSyncLocalInspirations && window.AICenterSyncLocalInspirations()',
      ).catch(() => {});
    }
  }

  private async openTarget(target: ConnectionTarget): Promise<void> {
    const generation = ++this.probeGeneration;
    this.serverUrl = target.serverUrl;
    this.serverInput = target.pageUrl || target.serverUrl;
    this.pageUrl = '';
    this.errorMessage = '正在确认电脑是否在线';
    this.shellStatus = ShellStatus.CHECKING;
    await this.rememberServer(target.serverUrl);
    const probe = await this.probeServer(target.serverUrl);
    if (generation !== this.probeGeneration) return;
    if (!probe.online) {
      this.showUnreachableError(target.serverUrl);
      return;
    }
    this.pageUrl = withUiRevision(target.pageUrl || target.serverUrl, probe.uiRevision);
    this.errorMessage = '';
    this.shellStatus = ShellStatus.READY;
  }

  private showUnreachableError(serverUrl: string): void {
    this.pageUrl = '';
    this.serverUrl = serverUrl;
    this.serverInput = serverUrl;
    this.errorMessage = serverUrl.startsWith('https://')
      ? '公网入口暂时连不上。已记住上次地址，电脑和隧道恢复后点重新连接即可，不必重新扫码。'
      : '电脑暂时连不上。已记住上次地址，服务启动后点重新连接即可，不必重新扫码。';
    this.shellStatus = ShellStatus.ERROR;
  }

  private handleMainFrameError(): void {
    if (this.shellStatus !== ShellStatus.READY && this.shellStatus !== ShellStatus.CHECKING) return;
    const generation = this.probeGeneration;
    const serverUrl = this.serverUrl;
    this.probeServer(serverUrl).then((probe: ProbeResult) => {
      if (generation !== this.probeGeneration) return;
      if (probe.online) return;
      this.showUnreachableError(serverUrl);
    }).catch(() => {
      if (generation !== this.probeGeneration) return;
      this.showUnreachableError(serverUrl);
    });
  }

  private async forgetSavedServer(): Promise<void> {
    if (!this.preferenceStore) return;
    try {
      await this.preferenceStore.delete(SERVER_URL_KEY);
      await this.preferenceStore.flush();
    } catch (_error) {
      // 内存状态已经重置，下次仍可通过新二维码覆盖旧地址。
    }
  }

  private returnToSetup(message: string = ''): void {
    this.probeGeneration += 1;
    this.pageUrl = '';
    this.serverUrl = '';
    this.serverInput = '';
    this.errorMessage = message;
    this.shellStatus = ShellStatus.SETUP;
    this.forgetSavedServer();
  }

  private async scanPairingCode(): Promise<void> {
    this.errorMessage = '';
    this.isScanning = true;
    try {
      const context = this.getAbilityContext();
      const result = await scanBarcode.startScanForResult(context, {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableAlbum: true,
      });
      const target = pairingConnectionFrom(result.originalValue);
      if (!target.valid) {
        this.errorMessage = '这不是 AI Center 配对码，请扫描电脑端“连接手机”中的二维码。';
        return;
      }
      await this.openTarget(target);
    } catch (error) {
      const businessError = error as BusinessError;
      if (businessError.code !== 1000500002) {
        this.errorMessage = businessError.message || '扫码未完成，请重试。';
      }
    } finally {
      this.isScanning = false;
    }
  }

  private connectFromInput(): void {
    const target = connectionFrom(this.serverInput);
    if (!target.valid) {
      this.errorMessage = '请输入 http:// 或 https:// 开头的 AI Center 地址';
      return;
    }
    this.openTarget(target);
  }

  private retry(): void {
    const target = connectionFrom(this.serverUrl || this.serverInput);
    if (!target.valid) {
      this.returnToSetup('没有已保存的电脑地址，请重新扫码。');
      return;
    }
    this.openTarget(target);
  }

  private changeServer(): void {
    this.returnToSetup();
  }

  private openLocalInspiration(): void {
    this.getUIContext().getRouter().pushUrl({ url: 'pages/LocalInspiration' }).catch(() => {
      this.errorMessage = '无法打开本地灵感，请稍后重试。';
    });
  }

  private openInSystemBrowser(url: string): void {
    const href = url.trim();
    if (!isHttpUrl(href) || isAppUrl(href, this.serverUrl)) return;
    try {
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: href,
      };
      this.getAbilityContext().startAbility(want).catch((_error: BusinessError) => {});
    } catch (_error) {
      // 外链打不开时保留当前 ArkWeb，不把知乎等站点载入壳内。
    }
  }

  private interceptNavigation(url: string): boolean {
    if (url.startsWith(RESET_CONNECTION_URI)) {
      this.returnToSetup('已退出当前连接，请扫描新的二维码。');
      return true;
    }
    if (isHttpUrl(url) && !isAppUrl(url, this.serverUrl)) {
      this.openInSystemBrowser(url);
      return true;
    }
    return false;
  }

  @Builder
  private setupPage() {
    Column({ space: 16 }) {
      Blank().layoutWeight(1)
      Text('AI Center')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor('#182431')
      Text('连接你的本地信息中枢')
        .fontSize(15)
        .fontColor('#66182431')
      Button(this.isScanning ? '正在打开扫码…' : '扫描电脑端二维码')
        .width('100%')
        .height(52)
        .borderRadius(26)
        .backgroundColor('#0A59F7')
        .enabled(!this.isScanning)
        .onClick(() => this.scanPairingCode())
      Row({ space: 12 }) {
        Divider().layoutWeight(1).color('#1A182431')
        Text('或手动输入')
          .fontSize(12)
          .fontColor('#80182431')
        Divider().layoutWeight(1).color('#1A182431')
      }
      .width('100%')
      TextInput({
        text: this.serverInput,
        placeholder: '例如 http://192.168.1.10:8787',
      })
        .height(52)
        .width('100%')
        .backgroundColor('#FFFFFFFF')
        .borderRadius(16)
        .onChange((value: string) => this.serverInput = value)
      if (this.errorMessage) {
        Text(this.errorMessage)
          .width('100%')
          .fontSize(13)
          .fontColor('#D94838')
      }
      Button('手动连接')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .fontColor('#0A59F7')
        .backgroundColor('#FFFFFFFF')
        .onClick(() => this.connectFromInput())
      Button('打开本地灵感')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .fontColor('#0A59F7')
        .backgroundColor('#FFFFFFFF')
        .onClick(() => this.openLocalInspiration())
      Text('二维码只用于第一次配对。连上后会记住电脑地址和登录状态，下次打开先快速检查是否在线。')
        .fontSize(12)
        .fontColor('#99182431')
      Blank().layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 24, right: 24, top: 24, bottom: 24 })
    .backgroundColor('#F5F7FA')
  }

  @Builder
  private errorPage() {
    Column({ space: 16 }) {
      Text('暂时无法连接')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
      Text(this.errorMessage || '请确认电脑服务正在运行。已保存的地址不会因为这次失败而被清除。')
        .fontSize(14)
        .fontColor('#99182431')
        .textAlign(TextAlign.Center)
      Button('重新连接')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .backgroundColor('#0A59F7')
        .onClick(() => this.retry())
      Button('更换服务器')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .fontColor('#0A59F7')
        .backgroundColor('#FFFFFFFF')
        .onClick(() => this.changeServer())
      Button('扫描新二维码')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .fontColor('#0A59F7')
        .backgroundColor('#FFFFFFFF')
        .onClick(() => {
          this.returnToSetup();
          this.scanPairingCode();
        })
      Button('打开本地灵感')
        .width('100%')
        .height(48)
        .borderRadius(24)
        .fontColor('#0A59F7')
        .backgroundColor('#FFFFFFFF')
        .onClick(() => this.openLocalInspiration())
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(24)
    .backgroundColor('#F5F7FA')
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.shellStatus === ShellStatus.SETUP) {
        this.setupPage()
      } else if (this.shellStatus === ShellStatus.ERROR) {
        this.errorPage()
      } else if (this.shellStatus === ShellStatus.CHECKING || !this.pageUrl) {
        Column({ space: 12 }) {
          LoadingProgress()
            .width(32)
            .height(32)
            .color('#0A59F7')
          Text(this.errorMessage || '正在确认电脑是否在线')
            .fontSize(13)
            .fontColor('#99182431')
        }
        .padding(24)
      } else {
        Web({ src: this.pageUrl, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .fileAccess(false)
          .geolocationAccess(false)
          .cacheMode(CacheMode.Default)
          .javaScriptProxy({
            object: this.shellBridge,
            name: 'AICenterShell',
            methodList: [
              'resetConnection',
              'openExternalUrl',
              'getLocalInspirationOutbox',
              'acknowledgeLocalInspiration',
              'markLocalInspirationError',
            ],
            controller: this.controller,
          })
          .onControllerAttached(() => {
            try {
              this.controller.setCustomUserAgent(`${this.controller.getUserAgent()}${SHELL_UA}`);
            } catch (_error) {
              // 页面仍可继续加载，UA 标记只用于渐进增强。
            }
            this.persistWebSession();
          })
          .onLoadIntercept((event: ShellWebInterceptEvent): boolean => {
            return this.interceptNavigation(event.data.getRequestUrl());
          })
          .onPageBegin(() => {
            this.persistWebSession();
          })
          .onPageEnd(() => {
            this.persistWebSession();
          })
          .onErrorReceive((event: ShellWebErrorEvent): void => {
            if (event.request.isMainFrame()) {
              this.handleMainFrameError();
            }
          })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F7FA')
  }
}
