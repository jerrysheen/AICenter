import { statSync } from 'node:fs';
import { loadYoutubePodcastConfig, watchUrl, YOUTUBE_PODCAST_JOB_TYPE, youtubePodcastsEnabled } from './youtube-podcasts.js';

function present(row, withBody = false) {
  return {
    videoId: row.videoId,
    creatorId: row.creatorId,
    title: row.displayTitle || row.title,
    originalTitle: row.title,
    publishedAt: row.publishedAt,
    durationSec: row.durationSec,
    summary: row.summary || '',
    transcriptSource: row.transcriptSource || '',
    sourceUrl: row.sourceUrl || watchUrl(row.videoId),
    contentItemId: row.contentItemId || '',
    ...(withBody ? { body: row.body || '' } : {}),
  };
}

export function createYoutubePodcastService({ repository, store, configPath, env = process.env }) {
  let cache = { stamp: '', creators: [], error: '' };

  function readConfig() {
    let stamp = 'missing';
    try {
      stamp = String(statSync(configPath).mtimeMs);
    } catch {
      stamp = 'missing';
    }
    if (cache.stamp === stamp) return cache;
    try {
      cache = { stamp, creators: loadYoutubePodcastConfig(configPath).creators, error: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'YouTube 播客配置无法读取';
      console.error(`[youtube-podcasts] ${message}`);
      cache = { stamp, creators: [], error: '配置缺失' };
    }
    return cache;
  }

  return {
    list(workspaceId) {
      const config = readConfig();
      const rows = repository.listReady(workspaceId, 200);
      const configured = config.creators;
      const grouped = configured.map((creator) => ({
        id: creator.id,
        name: creator.name,
        focus: creator.focus,
        episodes: rows.filter((row) => row.creatorId === creator.id).map((row) => present(row)),
      }));
      const known = new Set(configured.map((creator) => creator.id));
      for (const row of rows) {
        if (known.has(row.creatorId)) continue;
        known.add(row.creatorId);
        grouped.push({
          id: row.creatorId,
          name: row.authorName || row.creatorId,
          focus: '',
          episodes: rows.filter((item) => item.creatorId === row.creatorId).map((item) => present(item)),
        });
      }
      return { enabled: youtubePodcastsEnabled(env), configError: config.error, creators: grouped };
    },

    get(workspaceId, videoId) {
      const row = repository.getReady(workspaceId, videoId);
      return row ? present(row, true) : null;
    },

    enqueue(workspaceId) {
      if (!youtubePodcastsEnabled(env)) return { status: 'disabled' };
      const open = (store.listOpenJobs?.(YOUTUBE_PODCAST_JOB_TYPE) || [])[0];
      if (open) return { status: 'already-running', jobId: open.id };
      const job = store.createJob({
        type: YOUTUBE_PODCAST_JOB_TYPE,
        workspaceId,
        maxAttempts: 1,
        input: { workspaceId, manual: true },
      });
      return { status: 'queued', jobId: job.id };
    },
  };
}
