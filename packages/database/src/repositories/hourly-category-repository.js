import { parseContract } from '../../../contracts/src/index.js';
import { HourlyCategoryEditionSchema } from '../../../contracts/src/hourly-category.js';

export function createHourlyCategoryRepository(database, emitEvent) {
  return Object.freeze({
    save(workspaceId, edition) {
      const value = parseContract(HourlyCategoryEditionSchema, { ...edition, workspaceId });
      const hourStart = value.window.startAt;
      database.transaction(() => {
        database.prepare(`INSERT INTO hourly_category_editions
          (workspace_id, hour_start, id, status, value_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, hour_start) DO UPDATE SET
            id = excluded.id,
            status = excluded.status,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`).run(
          workspaceId,
          hourStart,
          value.id,
          value.status,
          JSON.stringify(value),
          value.generatedAt,
        );
        emitEvent('report.hourly-category.saved.v1', 'hourly-category-edition', value.id, {
          hourStart,
          status: value.status,
          categoryCount: value.categories.length,
          untaggedCount: value.untaggedCount,
          formatVersion: value.formatVersion,
        }, workspaceId);
      })();
      return value;
    },

    get(workspaceId, hourStart) {
      const row = database.prepare(`SELECT value_json FROM hourly_category_editions
        WHERE workspace_id = ? AND hour_start = ?`).get(workspaceId, hourStart);
      if (!row) return null;
      return parseContract(HourlyCategoryEditionSchema, JSON.parse(row.value_json));
    },
  });
}
