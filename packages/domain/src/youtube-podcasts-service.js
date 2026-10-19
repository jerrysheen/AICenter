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
  function creators() {
    try {
      return loadYoutubePodcastConfig(configPath).creators;
    } catch {
      return [];
    }
  }

  return {
    list(workspaceId) {
      const rows = repository.listReady(workspaceId);
      const configured = creators();
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
      return { creators: grouped };
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
