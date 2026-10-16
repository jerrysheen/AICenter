import { parseBilibiliImportInput, parseFlashFeedQuery, parseHideFlag, parsePatchUserItemStateInput, parsePersistFeedTranslationsInput, parsePostInput, parseTranslateBatchInput, parseTranslateInput, ValidationError } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';
import { labelEventLoop } from '../http/event-loop-blocks.js';
import { createPreparedSlotStore } from '../http/prepared-slots.js';
import { sendOffthreadJson } from '../http/offthread-json.js';
import { STORED_FEED_CACHE_PROVIDERS } from '../http/stale-read-cache.js';
import { FEED_FLASH_LIMIT, FEED_FLASH_SNAPSHOT_KEY, FEED_TRENDFORCE_SNAPSHOT_KEY, feedPrebuiltSlot, logFeedSlotMiss } from '../../../../packages/runtime/src/web-snapshot-jobs.js';
import { collectLocalizationUnits } from '../../../../packages/domain/src/localize-texts.js';
import { POLYMARKET_OUTCOME_GLOSSARY, POLYMARKET_OUTCOME_MODEL } from '../../../../packages/domain/src/polymarket-outcome-zh.js';

export function projectOfficialContentItem(row, localization = null, detail = null) {
  const releaseId = String(row?.releaseId || row?.eventId || '').trim();
  if (!releaseId) return null;
  const translated = String(localization?.text || '').trim();
  const body = String(detail?.bodyText || '').trim();
  return {
    id: `official/${releaseId}`,
    provider: 'official',
    externalId: releaseId,
    title: translated || row.title || '',
    originalTitle: row.title || '',
    body,
    summary: [row.authority, row.documentNumber].filter(Boolean).join(' · '),
    sourceUrl: row.sourceUrl || '',
    authorName: row.authority || '',
    publishedAt: row.publishedAt || row.scheduledAt || null,
    contentLevel: body ? 'full' : 'summary_only',
    kind: 'official',
    translation: translated ? { text: translated, engine: localization?.engine || '', targetLang: 'zh' } : null,
    translationStatus: localization?.status || (translated ? 'ready' : 'pending'),
  };
}

export async function readOfficialContentItem(services, workspaceId, releaseId) {
  const wanted = String(releaseId || '').replace(/^official[:/]/, '').trim();
  if (!wanted || !services?.staticSignalBoard?.read) return null;
  const loaded = await services.staticSignalBoard.read({
    from: 0,
    to: Date.now() + 400 * 86_400_000,
    limit: 300,
    releaseLimit: 200,
    focus: '0',
    includeUndated: '1',
  }, { refresh: false });
  const board = loaded?.board || loaded;
  const release = (board?.releases || []).find((row) => row.releaseId === wanted || row.documentNumber === wanted);
  const event = release ? null : (board?.upcoming || []).find((row) => row.eventId === wanted);
  const row = release || event;
  if (!row) return null;
  let localization = null;
  if (services.feed?.localizeTexts) {
    const units = collectLocalizationUnits(release ? { releases: [release] } : { upcoming: [event] });
    const projected = await services.feed.localizeTexts(units, { workspaceId }, { wait: false });
    localization = projected?.localizations?.[row.releaseId || row.eventId] || null;
  }
  let detail = null;
  if (row.sourceUrl && services.sources?.read) {
    try {
      const snapshot = await services.sources.read('policy.official-detail', { sourceUrl: row.sourceUrl }, { refresh: false });
      detail = snapshot?.data || null;
    } catch {
      detail = null;
    }
  }
  return projectOfficialContentItem(row, localization, detail);
}

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

export function createFeedRoutes({ slots = createPreparedSlotStore(), offthread = null } = {}) {
  return [
    { method: 'GET', path: /^\/api\/v1\/translate\/jobs\/([0-9a-f-]+)$/i,
      handler({ response, services, identity, params }) {
        const job = services.runtime.getJob(params.values[0]);
        if (!job || job.type !== 'feed.translation.run' || job.workspaceId !== workspaceIdFrom(identity)) {
          json(response, 404, { ok: false, error: '翻译任务不存在' }); return;
        }
        json(response, 200, { ok: true, status: job.status,
          availableAt: job.status === 'queued' ? job.availableAt : null,
          result: job.status === 'completed' ? job.output : null,
          error: job.status === 'failed' ? '翻译未完成，请稍后重试' : null });
      },
    },
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
      method: 'GET', path: /^\/api\/v1\/content-items\/official\/([^/]+)$/i,
      async handler({ response, services, identity, params }) {
        let requested = params.values[0];
        try { requested = decodeURIComponent(requested); } catch { /* keep the raw segment */ }
        const item = await readOfficialContentItem(services, workspaceIdFrom(identity), requested);
        if (!item) json(response, 404, { ok: false, error: '信息不存在' });
        else json(response, 200, { ok: true, item });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/content-items\/([^/]+)$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        let requested = params.values[0];
        try { requested = decodeURIComponent(requested); } catch { /* keep the raw segment */ }
        const item = services.feed.getLocalizedContentItem
          ? services.feed.getLocalizedContentItem(workspaceId, requested)
          : services.feed.getContentItem(workspaceId, requested);
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
      method: 'GET', path: '/api/v1/feed/flash',
      handler({ request, response, url }) {
        const query = parseFlashFeedQuery(Object.fromEntries(url.searchParams.entries()));
        if (query.limit !== FEED_FLASH_LIMIT) logFeedSlotMiss('flash', { feed: 'flash', limit: query.limit, fields: 'list' });
        slots.send(request, response, FEED_FLASH_SNAPSHOT_KEY, {
          headers: { 'Cache-Control': 'private, no-cache' },
        });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/feed(?:\/([a-z0-9-]+))?$/i,
      async handler({ request, response, services, url, params, feedQueryParsers, identity }) {
        const providerId = params.values[0] || url.searchParams.get('platform') || 'x';
        const parser = feedQueryParsers.get(providerId);
        if (!parser) throw new ValidationError(`尚未启用 ${providerId} 信息源`, ['platform']);
        try {
          const query = parser(Object.fromEntries(url.searchParams.entries()));
          const workspaceId = workspaceIdFrom(identity);
          if (providerId === 'trendforce') {
            const trendforceJob = query.refresh ? services.runtime.requestTrendforceSync({ workspaceId }) : null;
            slots.send(request, response, FEED_TRENDFORCE_SNAPSHOT_KEY, {
              headers: {
                'Cache-Control': 'private, no-cache',
                ...(trendforceJob ? { 'X-Job-Id': trendforceJob.id } : {}),
              },
            });
            return;
          }
          const mediaJob = providerId === 'media' && query.refresh ? services.runtime.requestMediaSync({ workspaceId, channel: query.channel }) : null;
          const prebuilt = STORED_FEED_CACHE_PROVIDERS.has(providerId) && !mediaJob
            ? feedPrebuiltSlot(providerId, query)
            : '';
          if (prebuilt) {
            slots.send(request, response, prebuilt, {
              headers: { 'Cache-Control': 'private, no-cache' },
              allow304: !query.refresh,
            });
            return;
          }
          if ((providerId === 'x' || providerId === 'xueqiu') && !query.refresh) {
            logFeedSlotMiss(providerId, query);
            await sendOffthreadJson(offthread, request, response, {
              kind: 'feed',
              workspace: workspaceId,
              providerId,
              query,
            }, { 'Cache-Control': 'private, no-cache' });
            return;
          }
          if (providerId === 'x' || providerId === 'xueqiu') logFeedSlotMiss(providerId, query);
          const leave = labelEventLoop(`feed.${providerId}`);
          let pending;
          try {
            pending = services.feed.getExternalFeed(providerId, query, { workspaceId });
          } finally {
            leave();
          }
          const feed = await pending;
          const payload = { ok: true, feed, ...(mediaJob ? { jobId: mediaJob.id } : {}) };
          json(response, 200, payload, {}, { compress: providerId === 'media' });
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
          const input = parseTranslateInput(await readJson(request));
          const job = services.runtime.requestTranslation({ workspaceId: workspaceIdFrom(identity), targetLang: input.targetLang,
            items: [{ id: input.id || 'translation', text: input.text }] });
          events.flush();
          json(response, 202, { ok: true, jobId: job?.id || '' });
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
          const input = parseTranslateBatchInput(await readJson(request));
          const job = services.runtime.requestTranslation({
            workspaceId: workspaceIdFrom(identity),
            targetLang: input.targetLang,
            items: input.items,
            ...(input.outcomeGlossary ? { glossary: POLYMARKET_OUTCOME_GLOSSARY, model: POLYMARKET_OUTCOME_MODEL } : {}),
          });
          events.flush();
          json(response, 202, { ok: true, jobId: job?.id || '' });
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
