import { parseBilibiliImportInput, parseHideFlag, parsePersistFeedTranslationsInput, parsePostInput, parseTranslateBatchInput, parseTranslateInput, ValidationError } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createFeedRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/posts',
      handler({ response, services, url }) {
        json(response, 200, {
          ok: true,
          posts: services.feed.listLegacyPosts(Number(url.searchParams.get('limit') || 100)),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/posts',
      async handler({ request, response, identity, services, events }) {
        const post = services.feed.createLegacyPost(parsePostInput(await readJson(request)), {
          deviceId: identity.device?.id || null,
        });
        events.flush();
        json(response, 201, { ok: true, post });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/content-items\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const item = services.feed.getContentItem(workspaceId, params.values[0]);
        if (!item) json(response, 404, { ok: false, error: '信息不存在' });
        else json(response, 200, { ok: true, item });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/posts\/([0-9a-f-]+)$/i,
      handler({ response, services, params }) {
        const post = services.feed.getLegacyPost(params.values[0]);
        if (!post) json(response, 404, { ok: false, error: '信息不存在' });
        else json(response, 200, { ok: true, post });
      },
    },
    {
      method: 'PATCH', path: /^\/api\/v1\/content-items\/([0-9a-f-]{36})\/state$/i,
      async handler({ request, response, services, identity, events, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        parseHideFlag(await readJson(request));
        const state = services.feed.hideContentItem(workspaceId, params.values[0]);
        if (!state) json(response, 404, { ok: false, error: '信息不存在' });
        else {
          events.flush();
          json(response, 200, { ok: true, state });
        }
      },
    },
    {
      method: 'PATCH', path: /^\/api\/v1\/posts\/([0-9a-f-]{36})\/state$/i,
      async handler({ request, response, services, events, params }) {
        parseHideFlag(await readJson(request));
        const hidden = services.feed.hideLegacyPost(params.values[0]);
        if (!hidden) json(response, 404, { ok: false, error: '信息不存在' });
        else {
          events.flush();
          json(response, 200, { ok: true, hidden: true });
        }
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/feed(?:\/([a-z0-9-]+))?$/i,
      async handler({ response, services, url, params, feedQueryParsers, identity }) {
        const providerId = params.values[0] || url.searchParams.get('platform') || 'x';
        const parser = feedQueryParsers.get(providerId);
        if (!parser) throw new ValidationError(`尚未启用 ${providerId} 信息源`, ['platform']);
        try {
          const feed = await services.feed.getExternalFeed(
            providerId,
            parser(Object.fromEntries(url.searchParams.entries())),
            { workspaceId: identity?.device?.workspaceId || 'local' },
          );
          json(response, 200, { ok: true, feed });
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '信息流加载失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/feed/bilibili',
      async handler({ request, response, services, identity, events }) {
        try {
          const feed = await services.feed.getExternalFeed(
            'bilibili',
            parseBilibiliImportInput(await readJson(request)),
            { workspaceId: identity?.device?.workspaceId || 'local' },
          );
          events.flush();
          json(response, 200, { ok: true, feed });
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : 'B 站抓取失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/translate',
      async handler({ request, response, services, identity, events }) {
        try {
          const translation = await services.feed.translate(parseTranslateInput(await readJson(request)), {
            workspaceId: identity?.device?.workspaceId || 'local',
          });
          events.flush();
          json(response, 200, { ok: true, translation });
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '翻译失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/translate/batch',
      async handler({ request, response, services, identity, events }) {
        try {
          const payload = await services.feed.translateMany(parseTranslateBatchInput(await readJson(request)), {
            workspaceId: identity?.device?.workspaceId || 'local',
          });
          events.flush();
          json(response, 200, { ok: true, ...payload });
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          const message = error instanceof Error ? error.message : '翻译失败';
          json(response, /进行中/.test(message) ? 409 : 502, { ok: false, error: message });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/feed/translations',
      async handler({ request, response, services, identity, events }) {
        const payload = parsePersistFeedTranslationsInput(await readJson(request));
        services.feed.persistItemTranslations(payload.translations, {
          workspaceId: identity?.device?.workspaceId || 'local',
        });
        events.flush();
        json(response, 200, { ok: true, saved: payload.translations.length });
      },
    },
  ];
}
