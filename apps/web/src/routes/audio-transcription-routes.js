import { AudioTranscriptionCreateSchema, parseContract } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createAudioTranscriptionRoutes() {
  return [
    {
      method: 'POST',
      path: '/api/v1/audio-transcriptions',
      async handler({ request, response, services, identity, events }) {
        if (identity?.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '语音转写只能在本机执行' });
          return;
        }
        const body = parseContract(AudioTranscriptionCreateSchema, await readJson(request));
        const job = await services.runtime.requestAudioTranscription({
          ...body,
          workspaceId: 'local',
        });
        events.flush();
        json(response, 202, {
          ok: true,
          runId: job.id,
          status: job.status,
          plan: job.input.plan,
        });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/audio-transcriptions\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        if (identity?.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '语音转写只能在本机执行' });
          return;
        }
        const payload = services.runtime.getAudioTranscription(params.values[0], 'local');
        if (!payload) {
          json(response, 404, { ok: false, error: '转写任务不存在' });
          return;
        }
        json(response, 200, { ok: true, ...payload });
      },
    },
  ];
}
