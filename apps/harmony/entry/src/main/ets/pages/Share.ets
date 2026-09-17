import { common, UIExtensionContentSession } from '@kit.AbilityKit';
import { LocalInspirationStore } from '../storage/LocalInspirationStore';

const storage = LocalStorage.getShared();

interface ShareDraft {
  body: string;
  title: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceApp: string;
}

@Entry(storage)
@Component
struct Share {
  private session: UIExtensionContentSession | undefined = storage.get<UIExtensionContentSession>('session');
  private rawDraft: string = storage.get<string>('shareDraft') ?? '{}';
  private store: LocalInspirationStore = new LocalInspirationStore();
  private draft: ShareDraft = { body: '', title: '', sourceTitle: '', sourceUrl: '', sourceApp: '' };
  @State body: string = '';
  @State saving: boolean = false;
  @State errorMessage: string = '';

  aboutToAppear(): void {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      this.draft = JSON.parse(this.rawDraft) as ShareDraft;
      this.body = String(this.draft.body || '').trim();
      const context = this.getUIContext().getHostContext();
      if (!context) throw new Error('无法获取应用上下文');
      await this.store.initialize(context as common.UIExtensionContext);
      if (!this.body) this.errorMessage = '没有收到可以保存的文本。';
    } catch (_error) {
      this.errorMessage = '分享内容读取失败，请返回后重试。';
    }
  }

  private close(): void {
    this.session?.terminateSelf().catch(() => {});
  }

  private async save(): Promise<void> {
    if (!this.body.trim() || this.saving) return;
    this.saving = true;
    this.errorMessage = '';
    try {
      await this.store.create({
        body: this.body,
        title: this.draft.title,
        sourceType: 'external-share',
        sourceUrl: this.draft.sourceUrl,
        sourceTitle: this.draft.sourceTitle,
        captureChannel: 'harmony-share',
        sourceApp: this.draft.sourceApp,
      });
      this.close();
    } catch (error) {
      this.errorMessage = (error as Error).message || '保存失败，请重试。';
      this.saving = false;
    }
  }

  build() {
    Column({ space: 16 }) {
      Row() {
        Text('保存为灵感')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor('#182431')
        Blank()
        Button('取消')
          .fontColor('#0A59F7')
          .backgroundColor(Color.Transparent)
          .onClick(() => this.close())
      }
      .width('100%')

      if (this.draft.sourceTitle || this.draft.sourceUrl) {
        Text(this.draft.sourceTitle || this.draft.sourceUrl)
          .width('100%')
          .fontSize(12)
          .fontColor('#80182431')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      TextArea({ text: this.body, placeholder: '输入要保存的内容' })
        .width('100%')
        .layoutWeight(1)
        .backgroundColor('#FFFFFFFF')
        .borderRadius(16)
        .onChange((value: string) => this.body = value)

      if (this.errorMessage) {
        Text(this.errorMessage)
          .width('100%')
          .fontSize(13)
          .fontColor('#D94838')
      }

      Text('内容会先保存在本机；连接 AI Center 后自动同步并去重。')
        .width('100%')
        .fontSize(12)
        .fontColor('#80182431')

      Button(this.saving ? '正在保存…' : '保存')
        .width('100%')
        .height(50)
        .borderRadius(25)
        .backgroundColor('#0A59F7')
        .enabled(Boolean(this.body.trim()) && !this.saving)
        .onClick(() => this.save())
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .backgroundColor('#F5F7FA')
  }
}
