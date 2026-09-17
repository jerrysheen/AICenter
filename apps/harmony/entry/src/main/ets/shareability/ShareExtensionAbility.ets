import { ShareExtensionAbility, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0xA1C0;
const TAG = 'AI_CENTER_SHARE';
const MAX_SHARED_TEXT_LENGTH = 100_000;

interface ShareDraft {
  body: string;
  title: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceApp: string;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function firstHttpUrl(value: string): string {
  const match = value.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.;]+$/, '').slice(0, 2048) : '';
}

function toShareDraft(records: Array<systemShare.SharedRecord>): ShareDraft {
  const textParts: Array<string> = [];
  let sourceUrl = '';
  let sourceTitle = '';
  for (const record of records) {
    const content = String(record.content ?? '').trim();
    const title = String(record.title ?? '').trim();
    if (!sourceTitle && title) sourceTitle = title.slice(0, 500);
    if (!content) continue;
    if (!sourceUrl) sourceUrl = firstHttpUrl(content);
    if (record.utd === 'general.hyperlink' || isHttpUrl(content)) {
      if (record.utd === 'general.hyperlink') continue;
    }
    textParts.push(content);
  }
  const joined = textParts.join('\n\n').trim();
  return {
    body: (joined || sourceTitle || sourceUrl).slice(0, MAX_SHARED_TEXT_LENGTH),
    title: '',
    sourceTitle,
    sourceUrl,
    sourceApp: '',
  };
}

export default class AICenterShareExtensionAbility extends ShareExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    systemShare.getSharedData(want)
      .then((data: systemShare.SharedData) => {
        const storage = new LocalStorage();
        storage.setOrCreate<UIExtensionContentSession>('session', session);
        storage.setOrCreate<string>('shareDraft', JSON.stringify(toShareDraft(data.getRecords())));
        session.loadContent('pages/Share', storage);
      })
      .catch((error: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'Unable to read shared data: %{public}s', error.message);
        session.terminateSelf().catch(() => {});
      });
  }
}
