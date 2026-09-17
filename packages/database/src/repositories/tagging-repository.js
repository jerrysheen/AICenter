import { parseContract, SaveResourceTaggingInputSchema } from '../../../contracts/src/index.js';

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  return {
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    tags: parseTags(row.tags_json),
    tagCatalogVersion: row.tag_catalog_version,
    promptVersion: row.prompt_version,
    model: row.model || '',
    truncatedForModel: Boolean(row.truncated_for_model),
    analyzedAt: row.analyzed_at,
  };
}

export function createTaggingRepository(database, emitEvent) {
  return Object.freeze({
    saveTaggings(values) {
      const records = (Array.isArray(values) ? values : [values])
        .map((value) => parseContract(SaveResourceTaggingInputSchema, value));
      if (!records.length) return [];
      const saved = [];
      database.transaction(() => {
        const statement = database.prepare(`INSERT INTO resource_taggings
          (workspace_id, resource_type, resource_id, tags_json, tag_catalog_version, prompt_version,
           model, truncated_for_model, analyzed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, resource_type, resource_id) DO UPDATE SET
            tags_json = excluded.tags_json,
            tag_catalog_version = excluded.tag_catalog_version,
            prompt_version = excluded.prompt_version,
            model = excluded.model,
            truncated_for_model = excluded.truncated_for_model,
            analyzed_at = excluded.analyzed_at,
            updated_at = excluded.updated_at`);
        for (const input of records) {
          const analyzedAt = input.analyzedAt || Date.now();
          statement.run(
            input.workspaceId,
            input.resourceType,
            input.resourceId,
            JSON.stringify(input.tags),
            input.tagCatalogVersion,
            input.promptVersion,
            input.model || '',
            input.truncatedForModel ? 1 : 0,
            analyzedAt,
            analyzedAt,
            analyzedAt,
          );
          emitEvent('tagging.resource.saved.v1', 'resource-tagging', input.resourceId, {
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            tags: input.tags,
            tagCatalogVersion: input.tagCatalogVersion,
            promptVersion: input.promptVersion,
          }, input.workspaceId);
          saved.push({
            workspaceId: input.workspaceId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            tags: input.tags,
            tagCatalogVersion: input.tagCatalogVersion,
            promptVersion: input.promptVersion,
            model: input.model || '',
            truncatedForModel: Boolean(input.truncatedForModel),
            analyzedAt,
          });
        }
      })();
      return saved;
    },

    getTagging(workspaceId, resourceType, resourceId) {
      const row = database.prepare(`SELECT * FROM resource_taggings
        WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`)
        .get(workspaceId, resourceType, resourceId);
      return row ? mapRow(row) : null;
    },

    listTaggings(workspaceId, resourceType, resourceIds = []) {
      const ids = [...new Set((resourceIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT * FROM resource_taggings
        WHERE workspace_id = ? AND resource_type = ? AND resource_id IN (${placeholders})`)
        .all(workspaceId, resourceType, ...ids);
      return rows.map(mapRow);
    },

    listByTags(workspaceId, resourceType, tagIds = [], { limit = 500 } = {}) {
      const tags = [...new Set((tagIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!tags.length) return [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1_000));
      const placeholders = tags.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT rt.* FROM resource_taggings rt
        WHERE rt.workspace_id = ? AND rt.resource_type = ?
          AND EXISTS (
            SELECT 1 FROM json_each(rt.tags_json)
            WHERE json_each.value IN (${placeholders})
          )
        ORDER BY rt.analyzed_at DESC, rt.resource_id DESC
        LIMIT ?`).all(workspaceId, resourceType, ...tags, safeLimit);
      return rows.map(mapRow);
    },
  });
}
