import { common } from '@kit.AbilityKit';
import { preferences, relationalStore } from '@kit.ArkData';

const DATABASE_NAME = 'ai_center_local_inspirations.db';
const LEGACY_PREFERENCE_FILE = 'ai_center_local_inspirations';
const LEGACY_RECORDS_KEY = 'records_v1';
const MAX_SYNCED_RECORDS = 200;
const CREATE_STATE_TABLE = `CREATE TABLE IF NOT EXISTS local_inspiration_state (
  id INTEGER PRIMARY KEY,
  records_json TEXT NOT NULL
)`;
const DATABASE_CONFIG: relationalStore.StoreConfig = {
  name: DATABASE_NAME,
  securityLevel: relationalStore.SecurityLevel.S1,
};

export type LocalSyncState = 'pending' | 'synced' | 'delete-pending' | 'error';

export interface LocalInspirationDraft {
  body: string;
  title?: string;
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  captureChannel?: string;
  sourceApp?: string;
  capturedAt?: number;
}

export class LocalInspirationRecord {
  clientMutationId: string = '';
  serverId: string = '';
  body: string = '';
  title: string = '';
  sourceType: string = '';
  sourceId: string = '';
  sourceUrl: string = '';
  sourceTitle: string = '';
  captureChannel: string = '';
  sourceApp: string = '';
  capturedAt: number = 0;
  syncState: LocalSyncState = 'pending';
  errorMessage: string = '';
}

function mutationId(): string {
  return `harmony-${Date.now().toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(36)}`;
}

function clean(value: string | undefined, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function contentKey(body: string, sourceUrl: string): string {
  return `${body.trim()}\n${sourceUrl.trim().toLowerCase()}`;
}

function copyRecord(source: LocalInspirationRecord): LocalInspirationRecord {
  const target = new LocalInspirationRecord();
  target.clientMutationId = source.clientMutationId;
  target.serverId = source.serverId;
  target.body = source.body;
  target.title = source.title;
  target.sourceType = source.sourceType;
  target.sourceId = source.sourceId;
  target.sourceUrl = source.sourceUrl;
  target.sourceTitle = source.sourceTitle;
  target.captureChannel = source.captureChannel;
  target.sourceApp = source.sourceApp;
  target.capturedAt = source.capturedAt;
  target.syncState = source.syncState;
  target.errorMessage = source.errorMessage;
  return target;
}

function recordFromDraft(draft: LocalInspirationDraft, body: string, sourceUrl: string): LocalInspirationRecord {
  const record = new LocalInspirationRecord();
  record.clientMutationId = mutationId();
  record.body = body;
  record.title = clean(draft.title, 200);
  record.sourceType = clean(draft.sourceType, 64);
  record.sourceId = clean(draft.sourceId, 256);
  record.sourceUrl = sourceUrl;
  record.sourceTitle = clean(draft.sourceTitle, 500);
  record.captureChannel = clean(draft.captureChannel, 32) || 'harmony-local';
  record.sourceApp = clean(draft.sourceApp, 200);
  record.capturedAt = draft.capturedAt && draft.capturedAt > 0 ? draft.capturedAt : Date.now();
  return record;
}

export class LocalInspirationStore {
  private store: relationalStore.RdbStore | null = null;
  private context: common.Context | null = null;
  private records: Array<LocalInspirationRecord> = [];

  async initialize(context: common.Context): Promise<void> {
    try {
      this.context = context;
      this.store = await relationalStore.getRdbStore(context, DATABASE_CONFIG);
      await this.store.executeSql(CREATE_STATE_TABLE);
      await this.reload();
      if (this.records.length === 0) await this.migrateLegacyPreferences();
    } catch (error) {
      this.store = null;
      throw new Error((error as Error).message || '无法读取本地灵感');
    }
  }

  async reload(): Promise<void> {
    if (!this.store) return;
    let raw = '[]';
    let resultSet: relationalStore.ResultSet | null = null;
    try {
      resultSet = await this.store.querySql('SELECT records_json FROM local_inspiration_state WHERE id = 1');
      if (resultSet.goToFirstRow()) {
        raw = resultSet.getString(resultSet.getColumnIndex('records_json'));
      }
      const parsed = JSON.parse(raw) as Array<LocalInspirationRecord>;
      this.records = Array.isArray(parsed) ? parsed.map((item) => copyRecord(item)) : [];
    } catch (_error) {
      this.records = [];
    } finally {
      if (resultSet) resultSet.close();
    }
    this.compact();
  }

  private async migrateLegacyPreferences(): Promise<void> {
    if (!this.context) return;
    try {
      const legacy = await preferences.getPreferences(this.context, LEGACY_PREFERENCE_FILE);
      const raw = String(await legacy.get(LEGACY_RECORDS_KEY, '[]'));
      const parsed = JSON.parse(raw) as Array<LocalInspirationRecord>;
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      this.records = parsed.map((item) => copyRecord(item));
      await this.persist();
    } catch (_error) {
      // 旧存储可能不存在；不影响新的 RDB 收件箱。
    }
  }

  listVisible(): Array<LocalInspirationRecord> {
    return this.records
      .filter((item) => item.syncState !== 'delete-pending')
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .map((item) => copyRecord(item));
  }

  getOutboxJson(): string {
    return JSON.stringify(this.records.filter((item) => (
      item.syncState === 'pending' || item.syncState === 'error'
    )));
  }

  async create(draft: LocalInspirationDraft): Promise<LocalInspirationRecord> {
    await this.reload();
    const body = clean(draft.body, 100_000);
    if (!body) throw new Error('灵感内容不能为空');
    const sourceUrl = clean(draft.sourceUrl, 2048);
    const duplicate = this.records.find((item) => (
      item.syncState !== 'delete-pending' &&
      contentKey(item.body, item.sourceUrl) === contentKey(body, sourceUrl)
    ));
    if (duplicate) return copyRecord(duplicate);
    const record = recordFromDraft(draft, body, sourceUrl);
    this.records.unshift(record);
    await this.persist();
    return copyRecord(record);
  }

  async delete(clientMutationId: string): Promise<void> {
    await this.reload();
    const index = this.records.findIndex((item) => item.clientMutationId === clientMutationId);
    if (index < 0) return;
    this.records.splice(index, 1);
    await this.persist();
  }

  acknowledge(clientMutationId: string, serverId: string): void {
    const index = this.records.findIndex((item) => item.clientMutationId === clientMutationId);
    if (index < 0) return;
    this.records[index].serverId = serverId;
    this.records[index].syncState = 'synced';
    this.records[index].errorMessage = '';
    this.persistSoon();
  }

  markError(clientMutationId: string, message: string): void {
    const index = this.records.findIndex((item) => item.clientMutationId === clientMutationId);
    if (index < 0) return;
    this.records[index].syncState = 'error';
    this.records[index].errorMessage = clean(message, 300);
    this.persistSoon();
  }

  private compact(): void {
    const localRecords = this.records.filter((item) => (
      item.syncState !== 'delete-pending' && !item.clientMutationId.startsWith('server-')
    ));
    const pending = localRecords.filter((item) => item.syncState !== 'synced');
    const synced = localRecords.filter((item) => item.syncState === 'synced')
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, MAX_SYNCED_RECORDS);
    const seen = new Set<string>();
    const candidates: Array<LocalInspirationRecord> = [];
    pending.forEach((item) => candidates.push(item));
    synced.forEach((item) => candidates.push(item));
    this.records = candidates.filter((item) => {
      const key = item.serverId ? `server:${item.serverId}` : `client:${item.clientMutationId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private persistSoon(): void {
    this.persist().then(() => {}, () => {});
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    this.compact();
    try {
      await this.store.executeSql(
        'INSERT OR REPLACE INTO local_inspiration_state (id, records_json) VALUES (1, ?)',
        [JSON.stringify(this.records)],
      );
    } catch (error) {
      throw new Error((error as Error).message || '无法保存本地灵感');
    }
  }
}
