import { json } from '../http/response.js';
import { collectLocalizationUnits } from '../../../../packages/domain/src/localize-texts.js';
import { emptyStaticSignalBoard, readMarketNativeBoard } from '../../../../packages/source/src/index.js';

async function withLocalizations(services, identity, payload) {
  const units = collectLocalizationUnits(payload);
  if (!units.length || !services.feed?.localizeTexts) return { localizations: {} };
  const result = await services.feed.localizeTexts(units, {
    workspaceId: identity?.device?.workspaceId || 'local',
  }, { wait: false });
  return result;
}

export function createSourceRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/sources',
      handler({ response, services }) {
        json(response, 200, { ok: true, sources: services.sources.list() });
      },
    },
    {
      method: 'GET', path: '/api/v1/static-signals/board',
      async handler({ response, services, identity, url }) {
        const input = Object.fromEntries(url.searchParams.entries());
        const refresh = input.refresh === '1' || input.refresh === 'true';
        delete input.refresh;
        const loaded = services.staticSignalBoard?.read
          ? await services.staticSignalBoard.read(input, { refresh })
          : { board: emptyStaticSignalBoard(), pending: true };
        const { localizations } = await withLocalizations(services, identity, loaded.board);
        json(response, 200, loaded.pending
          ? { ok: true, board: loaded.board, localizations, pending: true }
          : { ok: true, board: loaded.board, localizations });
      },
    },
    {
      method: 'GET', path: '/api/v1/market-native/board',
      async handler({ response, services, identity, url }) {
        const input = Object.fromEntries(url.searchParams.entries());
        const refresh = input.refresh === '1' || input.refresh === 'true';
        delete input.refresh;
        const loaded = services.marketNativeBoard?.read
          ? await services.marketNativeBoard.read(input, { refresh })
          : { board: await readMarketNativeBoard(services.sources, input, { refresh }), pending: false };
        let board = loaded.board;
        if (services.eventQuotes?.attachPriorPrices) {
          try {
            board = services.eventQuotes.attachPriorPrices(board);
          } catch (error) {
            console.error('[market-native] 24h snapshot lookup skipped:', error instanceof Error ? error.message : error);
          }
        }
        const { localizations } = await withLocalizations(services, identity, board);
        json(response, 200, loaded.pending
          ? { ok: true, board, localizations, pending: true }
          : { ok: true, board, localizations });
      },
    },
    {
      method: 'GET', path: '/api/v1/official-detail',
      async handler({ response, services, url }) {
        const sourceUrl = String(url.searchParams.get('sourceUrl') || '').trim();
        if (!sourceUrl) {
          json(response, 400, { ok: false, error: '缺少 sourceUrl' });
          return;
        }
        const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
        const snapshot = await services.sources.read('policy.official-detail', { sourceUrl }, { refresh });
        json(response, 200, { ok: true, snapshot });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/sources\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)$/,
      async handler({ response, services, identity, params, url }) {
        const sourceId = params.values[0];
        const source = services.sources.describe(sourceId);
        if (source.visibility !== 'public') {
          json(response, 404, { ok: false, error: 'Source 不存在' });
          return;
        }
        const input = Object.fromEntries(url.searchParams.entries());
        const refresh = input.refresh === '1' || input.refresh === 'true';
        delete input.refresh;
        const snapshot = await services.sources.read(sourceId, input, { refresh,workspaceId:identity?.device?.workspaceId || 'local' });
        const { localizations } = await withLocalizations(services, identity, snapshot);
        json(response, 200, { ok: true, source, snapshot, localizations });
      },
    },
  ];
}
