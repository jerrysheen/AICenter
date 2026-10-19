import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';
import { YOUTUBE_PODCAST_JOB_TYPE, youtubePodcastsEnabled } from '../packages/domain/src/youtube-podcasts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function enqueueYoutubePodcasts(env = process.env) {
  if (!youtubePodcastsEnabled(env)) return { status: 'disabled' };
  const instance = resolveInstanceConfig({ env, repositoryRoot: root });
  const store = createStore(instance.databasePath);
  try {
    const open = store.listOpenJobs(YOUTUBE_PODCAST_JOB_TYPE)[0];
    if (open) return { status: 'already-running', jobId: open.id };
    const job = store.createJob({
      type: YOUTUBE_PODCAST_JOB_TYPE,
      workspaceId: 'local',
      maxAttempts: 1,
      input: { workspaceId: 'local', manual: true },
    });
    return { status: 'queued', jobId: job.id };
  } finally {
    store.close();
  }
}

if (isMain(import.meta.url)) {
  const result = await enqueueYoutubePodcasts();
  console.log(JSON.stringify(result));
  if (result.status === 'disabled') process.exitCode = 1;
}
