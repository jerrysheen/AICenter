import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createYoutubePodcastService } from '../packages/domain/src/youtube-podcasts-service.js';
import { saveYoutubeEpisode } from '../packages/runtime/src/youtube-podcasts-job.js';

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'podcast-zone-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('podcast list keeps failed episodes, read state, and followed channels without a schema change', async () => {
  const opened = openStore();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'podcast-zone-config-'));
  const configPath = path.join(directory, 'youtube-podcasts.json');
  writeFileSync(configPath, JSON.stringify({
    creators: [
      { id: 'odd-lots', name: 'Odd Lots', focus: '金融', channels: [{ key: 'odd-lots', kind: 'playlist', url: 'https://www.youtube.com/@oddlots' }] },
      { id: 'all-in', name: 'All-In', focus: '科技', channels: [{ key: 'all-in', kind: 'playlist', url: 'https://www.youtube.com/@allin' }] },
    ],
  }));
  try {
    const creator = {
      id: 'odd-lots',
      name: 'Odd Lots',
      channels: [{ key: 'odd-lots', kind: 'playlist', url: 'https://www.youtube.com/@oddlots', handle: 'oddlots' }],
    };
    const item = await saveYoutubeEpisode({
      feedRepository: opened.store.repositories.feed,
      workspaceId: 'local',
      creator,
      episode: {
        videoId: 'readyvid0001',
        title: 'Rates',
        publishedAt: Date.parse('2026-10-18T01:00:00Z'),
        url: 'https://www.youtube.com/watch?v=readyvid0001',
        channelKey: 'odd-lots',
        durationSec: 4200,
      },
      summaryText: '中文摘要',
      displayTitle: '已经整理的一集',
      transcript: '## 要点\n\n主持人：正文。',
      transcriptSource: 'subtitle-manual',
    });
    const repository = opened.store.repositories.youtubePodcasts;
    repository.saveEpisode({
      workspaceId: 'local',
      videoId: 'readyvid0001',
      creatorId: 'odd-lots',
      channelKey: 'odd-lots',
      title: 'Rates',
      durationSec: 4200,
      publishedAt: Date.parse('2026-10-18T01:00:00Z'),
      status: 'ready',
      transcriptSource: 'subtitle-manual',
      contentItemId: item.id,
      articleStatus: 'ready',
    });
    repository.saveEpisode({
      workspaceId: 'local',
      videoId: 'failedvid001',
      creatorId: 'all-in',
      channelKey: 'all-in',
      title: 'No captions',
      durationSec: 1800,
      publishedAt: Date.parse('2026-10-19T01:00:00Z'),
      status: 'failed',
      reason: 'transcribe-unavailable',
    });
    opened.store.repositories.feed.upsertUserItemState({
      workspaceId: 'local',
      contentItemId: item.id,
      isRead: true,
    });
    const followed = opened.store.repositories.authors.setFollow('local', 'youtube:odd-lots', true);
    assert.equal(followed?.followed, true);
    const service = createYoutubePodcastService({
      repository,
      store: opened.store,
      configPath,
      env: { AI_CENTER_YOUTUBE_PODCASTS: '1' },
    });
    const listed = service.list('local');
    const odd = listed.creators.find((creator) => creator.id === 'odd-lots');
    const allIn = listed.creators.find((creator) => creator.id === 'all-in');
    assert.equal(odd.followed, true);
    assert.equal(allIn.followed, false);
    assert.equal(odd.episodes.length, 1);
    assert.equal(odd.episodes[0].isRead, true);
    assert.equal(odd.episodes[0].title, '已经整理的一集');
    assert.equal(odd.episodes[0].articleStatus, 'ready');
    assert.equal(allIn.episodes.length, 1);
    assert.equal(allIn.episodes[0].status, 'failed');
    assert.equal(allIn.episodes[0].isRead, false);
    assert.equal(repository.listReady('local').some((row) => row.videoId === 'failedvid001'), false);
    const failed = service.get('local', 'failedvid001');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.creatorName, 'All-In');
    assert.equal(Object.hasOwn(failed, 'body'), false);
    assert.notEqual(failed.article.status, 'ready');
    const progress = service.status('local', 'failedvid001');
    assert.equal(progress.status, 'failed');
    assert.equal(progress.title, 'No captions');
    assert.equal(Object.hasOwn(progress, 'body'), false);
    const ready = service.get('local', 'readyvid0001');
    assert.match(ready.body, /主持人/);
    assert.equal(ready.isRead, true);
    assert.equal(ready.article.status, 'ready');
  } finally {
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
