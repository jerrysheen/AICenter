import { parseBilibiliImportInput, parseHideFlag, parsePatchUserItemStateInput, parsePersistFeedTranslationsInput, parsePostInput, parseTranslateBatchInput, parseTranslateInput, ValidationError } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

export function createFeedRoutes() {
  return [
    {method:'GET',path:'/api/v1/feed/media/article',handler({response,services,identity,url}) {
      if(!services.media) {json(response,404,{ok:false,error:'文章不存在'});return;}
      const item=services.media.getSavedArticle(Object.fromEntries(url.searchParams),{workspaceId:workspaceIdFrom(identity)});
      json(response,item ? 200 : 404,item ? {ok:true,item} : {ok:false,error:'已保存文章不存在'});
    }},
    {method:'POST',path:'/api/v1/feed/quality/refresh',access:'desktop',async handler({request,response,services,identity}) {
      const body=await readJson(request);
      const job=services.runtime.requestFeedQualityRefresh({...body,workspaceId:workspaceIdFrom(identity)});
      json(response,202,{ok:true,jobId:job.id});
    }},
    {
      method: 'POST', path: '/api/v1/feed/media/probe',
      async handler({ request, response, services, identity }) {
        if (!services.media) throw new ValidationError('尚未启用 media 信息源', ['platform']);
        const body = await readJson(request);
        const sourceKeys = Array.isArray(body.sourceKeys)
          ? body.sourceKeys
          : String(body.sourceKeys || '').split(',').map((item) => item.trim()).filter(Boolean);
        if (body.run === true) {
          const job = services.runtime.requestMediaProbe({workspaceId:workspaceIdFrom(identity),sourceKeys,policyReviewed:body.policyReviewed === true});
          json(response,202,{ok:true,jobId:job.id});return;
        }
        const probe = await services.media.probe({
          workspaceId: workspaceIdFrom(identity),
          sourceKeys,
          policyReviewed: body.policyReviewed === true,
          run: body.run === true,
        });
        json(response, 200, { ok: true, probe });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/feed\/media\/sources\/([a-z0-9]+)\/(enable|disable)$/,
      handler({ response, services, identity, params }) {
        if (!services.media) throw new ValidationError('尚未启用 media 信息源', ['platform']);
        const workspaceId = workspaceIdFrom(identity);
        const result = params.values[1] === 'enable'
          ? services.media.enableSource(workspaceId, params.values[0])
          : services.media.disableSource(workspaceId, params.values[0]);
        json(response, result.ok ? 200 : 409, {
          ok: result.ok,
          error: result.ok ? '' : `来源未启用：${result.health}`,
          result,
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/feed/media/bodies',
      async handler({ request, response, services, identity }) {
        if (!services.media) throw new ValidationError('尚未启用 media 信息源', ['platform']);
        const body = await readJson(request);
        if (body.usageReviewed === true || body.repair === true) {
          if (identity?.kind !== 'desktop') { json(response,403,{ ok: false,error: '正文用途确认与修复只能在本机执行' }); return; }
          if (body.usageReviewed === true) services.media.acknowledgeBodyUse(workspaceIdFrom(identity),body.sourceKeys || []);
        }
        const job = services.runtime.requestMediaBodies({ workspaceId: workspaceIdFrom(identity), externalIds: body.externalIds || [], repair: body.repair === true });
        json(response, 202, { ok: true, jobId: job.id });
      },
    },
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
      method: 'GET', path: /^\/api\/v1\/(?:content-items|feed\/items)\/([^/]+)\/original$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const original = services.feed.getOriginalContent(workspaceId, decodeURIComponent(params.values[0]));
        if (!original) json(response, 404, { ok: false, error: '原文不存在' });
        else json(response, 200, { ok: true, original });
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
        const body = await readJson(request);
        const state = services.feed.patchContentItemState(parsePatchUserItemStateInput({
          workspaceId,
          contentItemId: params.values[0],
          ...body,
        }));
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
          const query = parser(Object.fromEntries(url.searchParams.entries()));
          const trendforceJob = providerId==='trendforce' && query.refresh ? services.runtime.requestTrendforceSync({workspaceId:workspaceIdFrom(identity)}) : null;
          if(trendforceJob) query.refresh=false;
          const mediaJob = providerId === 'media' && query.refresh ? services.runtime.requestMediaSync({ workspaceId: workspaceIdFrom(identity), channel: query.channel }) : null;
          const feed = await services.feed.getExternalFeed(
            providerId,
            query,
            { workspaceId: identity?.device?.workspaceId || 'local' },
          );
          json(response, 200, { ok: true, feed, ...((mediaJob || trendforceJob) ? { jobId: (mediaJob || trendforceJob).id } : {}) }, {}, { compress: providerId === 'media' });
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
