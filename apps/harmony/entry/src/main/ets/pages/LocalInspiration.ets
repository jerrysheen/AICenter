import { common } from '@kit.AbilityKit';
import { LocalInspirationRecord, LocalInspirationStore } from '../storage/LocalInspirationStore';

@Entry
@Component
struct LocalInspiration {
  private store: LocalInspirationStore = new LocalInspirationStore();
  @State draft: string = '';
  @State items: Array<LocalInspirationRecord> = [];
  @State message: string = '';
  @State saving: boolean = false;

  aboutToAppear(): void {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext();
      if (!context) throw new Error('无法获取应用上下文');
      await this.store.initialize(context as common.UIAbilityContext);
      this.refresh();
    } catch (_error) {
      this.message = '无法读取本地灵感，请稍后重试。';
    }
  }

  private refresh(): void {
    this.items = this.store.listVisible();
  }

  private async save(): Promise<void> {
    if (!this.draft.trim() || this.saving) return;
    this.saving = true;
    try {
      await this.store.create({
        body: this.draft,
        sourceType: 'manual',
        captureChannel: 'harmony-local',
      });
      this.draft = '';
      this.message = '已保存在本机，连接 AI Center 后会自动同步。';
      this.refresh();
    } catch (error) {
      this.message = (error as Error).message || '保存失败，请重试。';
    } finally {
      this.saving = false;
    }
  }

  private async remove(clientMutationId: string): Promise<void> {
    await this.store.delete(clientMutationId);
    this.message = '已从本机删除；AI Center 中已上传的内容不会被删除。';
    this.refresh();
  }

  private statusText(item: LocalInspirationRecord): string {
    if (item.syncState === 'synced') return '已同步';
    if (item.syncState === 'error') return '同步失败 · 将自动重试';
    return '待同步';
  }

  private capturedTime(item: LocalInspirationRecord): string {
    const date = new Date(item.capturedAt);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours().toString().padStart(2, '0');
    const minute = date.getMinutes().toString().padStart(2, '0');
    return `${month}-${day} ${hour}:${minute}`;
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回')
          .fontColor('#0A59F7')
          .backgroundColor(Color.Transparent)
          .onClick(() => this.getUIContext().getRouter().back())
        Text('本地灵感')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor('#182431')
        Blank()
        Text(`${this.items.length} 条`)
          .fontSize(12)
          .fontColor('#80182431')
      }
      .width('100%')
      .padding({ left: 12, right: 20, top: 12, bottom: 8 })

      Column({ space: 12 }) {
        TextArea({ text: this.draft, placeholder: '现在想到什么？离线也可以先记下来。' })
          .width('100%')
          .height(116)
          .backgroundColor('#FFFFFFFF')
          .borderRadius(16)
          .onChange((value: string) => this.draft = value)
        Button(this.saving ? '正在保存…' : '保存到本机')
          .width('100%')
          .height(48)
          .borderRadius(24)
          .backgroundColor('#0A59F7')
          .enabled(Boolean(this.draft.trim()) && !this.saving)
          .onClick(() => this.save())
        if (this.message) {
          Text(this.message)
            .width('100%')
            .fontSize(12)
            .fontColor('#99182431')
        }
      }
      .width('100%')
      .padding({ left: 20, right: 20, bottom: 12 })

      List({ space: 10 }) {
        ForEach(this.items, (item: LocalInspirationRecord) => {
          ListItem() {
            Column({ space: 8 }) {
              Text(item.title || item.body)
                .width('100%')
                .fontSize(15)
                .fontColor('#182431')
                .maxLines(4)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Row() {
                Text(`${this.capturedTime(item)} · ${this.statusText(item)}`)
                  .fontSize(11)
                  .fontColor(item.syncState === 'error' ? '#D94838' : '#80182431')
                Blank()
                Button('删除')
                  .fontSize(12)
                  .fontColor('#D94838')
                  .backgroundColor(Color.Transparent)
                  .onClick(() => this.remove(item.clientMutationId))
              }
              .width('100%')
            }
            .width('100%')
            .padding(16)
            .borderRadius(16)
            .backgroundColor('#FFFFFFFF')
          }
        }, (item: LocalInspirationRecord) => item.clientMutationId)
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 20, right: 20, bottom: 20 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F7FA')
  }
}
