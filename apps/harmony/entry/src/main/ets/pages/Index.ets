import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import { scanBarcode, scanCore } from '@kit.ScanKit';

const PREFERENCE_FILE = 'ai_center_connection';
const SERVER_URL_KEY = 'server_url';
const SHELL_UA = ' AI-Center-Harmony/0.2';
const CONNECTION_TIMEOUT_MS = 12000;

enum ShellStatus {
  SETUP,
  LOADING,
  READY,
  ERROR,
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
  private preferenceStore: preferences.Preferences | null = null;
  private loadTimeoutId: number = -1;
  @StorageLink('launchUri') @Watch('onLaunchUriChanged') launchUri: string = '';
  @State serverInput: string = '';
  @State serverUrl: string = '';
  @State pageUrl: string = '';
  @State shellStatus: ShellStatus = ShellStatus.SETUP;
  @State errorMessage: string = '';
  @State isScanning: boolean = false;

  aboutToAppear(): void {
    this.restoreConnection();
  }

  aboutToDisappear(): void {
    this.clearLoadTimeout();
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

  private async restoreConnection(): Promise<void> {
    try {
      const context = this.getAbilityContext();
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

  private async openTarget(target: ConnectionTarget): Promise<void> {
    this.serverUrl = target.serverUrl;
    this.serverInput = target.pageUrl;
    this.pageUrl = target.pageUrl;
    this.errorMessage = '';
    this.shellStatus = ShellStatus.LOADING;
    this.startLoadTimeout();
    if (this.preferenceStore) {
      try {
        await this.preferenceStore.put(SERVER_URL_KEY, target.serverUrl);
        await this.preferenceStore.flush();
      } catch (_error) {
        // 连接本身仍可继续；下一次成功扫码会再次尝试保存。
      }
    }
  }

  private clearLoadTimeout(): void {
    if (this.loadTimeoutId >= 0) {
      clearTimeout(this.loadTimeoutId);
      this.loadTimeoutId = -1;
    }
  }

  private startLoadTimeout(): void {
    this.clearLoadTimeout();
    this.loadTimeoutId = setTimeout(() => {
      if (this.shellStatus === ShellStatus.LOADING) {
        this.returnToSetup('上次地址无法连接，请确认电脑服务已启动后重新扫码。');
      }
    }, CONNECTION_TIMEOUT_MS);
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
    this.clearLoadTimeout();
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
    this.errorMessage = '';
    this.shellStatus = ShellStatus.LOADING;
    this.startLoadTimeout();
    try {
      this.controller.loadUrl(this.pageUrl);
    } catch (error) {
      this.errorMessage = (error as BusinessError).message || '重新连接失败';
      this.shellStatus = ShellStatus.ERROR;
    }
  }

  private changeServer(): void {
    this.returnToSetup();
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
      Text('二维码 10 分钟内有效；连接成功后会记住这台电脑。')
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
      Text(this.errorMessage || '请确认电脑服务正在运行，且手机和电脑位于同一局域网。')
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
    }
    .width('100%')
    .padding(24)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      if (!this.pageUrl || this.shellStatus === ShellStatus.SETUP) {
        this.setupPage()
      } else {
        Web({ src: this.pageUrl, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .geolocationAccess(false)
          .onControllerAttached(() => {
            try {
              this.controller.setCustomUserAgent(`${this.controller.getUserAgent()}${SHELL_UA}`);
            } catch (_error) {
              // 页面仍可继续加载，UA 标记只用于渐进增强。
            }
          })
          .onPageBegin(() => {
            this.shellStatus = ShellStatus.LOADING;
            this.startLoadTimeout();
          })
          .onPageEnd(() => {
            this.clearLoadTimeout();
            this.shellStatus = ShellStatus.READY;
          })
          .onErrorReceive((event) => {
            if (event && event.request.isMainFrame()) {
              this.returnToSetup('电脑地址已失效或服务未启动，请重新扫码连接。');
            }
          })

        if (this.shellStatus === ShellStatus.LOADING) {
          Column({ space: 12 }) {
            LoadingProgress()
              .width(32)
              .height(32)
              .color('#0A59F7')
            Text('正在连接 AI Center')
              .fontSize(13)
              .fontColor('#99182431')
          }
          .padding(24)
          .borderRadius(20)
          .backgroundColor('#F2FFFFFF')
        }

        if (this.shellStatus === ShellStatus.ERROR) {
          Column() {
            this.errorPage()
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor('#F5F7FA')
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F7FA')
  }
}
