import { createUsageFetch } from './model-usage-fetch.js';

const MODEL = 'gemini-3.5-transcribe';
const API_ROOT = 'https://generativelanguage.googleapis.com';

function clip(value) {
  return String(value || '').replace(/AQ\.[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function readAudioTranscript(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => part?.audioTranscription?.text || part?.text || '').join('').trim();
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: clip(text) } };
  }
}

function header(response, name) {
  return response.headers?.get?.(name) || response.headers?.get?.(name.toLowerCase()) || '';
}

export function createGeminiAudioTranscriber({ fetch: fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return async function transcribeAudio({ apiKey, audio, mimeType = 'audio/wav', languageCodes = [], mode = 'SMART', signal }) {
    const secret = String(apiKey || '').trim();
    if (!secret) throw new Error('转写密钥不可用');
    const started = await fetchImpl(`${API_ROOT}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': secret,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(audio.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'segment' } }),
      signal,
    });
    if (!started.ok) {
      const payload = await readJson(started);
      throw new Error(clip(payload.error?.message) || `音频上传失败 (${started.status})`);
    }
    const uploadUrl = header(started, 'x-goog-upload-url').trim();
    if (!uploadUrl) throw new Error('音频上传没有返回地址');
    const uploaded = await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(audio.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: audio,
      signal,
    });
    const filePayload = await readJson(uploaded);
    if (!uploaded.ok) throw new Error(clip(filePayload.error?.message) || `音频上传失败 (${uploaded.status})`);
    const file = filePayload.file || {};
    try {
      let state = file.state || 'ACTIVE';
      for (let attempt = 0; state === 'PROCESSING' && attempt < 5; attempt += 1) {
        await sleep(500);
        const polled = await fetchImpl(`${API_ROOT}/v1beta/${file.name}`, {
          headers: { 'x-goog-api-key': secret },
          signal,
        });
        const body = await readJson(polled);
        if (!polled.ok) throw new Error(clip(body.error?.message) || `音频文件状态读取失败 (${polled.status})`);
        state = body.state || body.file?.state || 'ACTIVE';
      }
      if (state !== 'ACTIVE') throw new Error('音频文件尚未就绪');
      const response = await createUsageFetch(fetchImpl, { provider: 'gemini', model: MODEL, stage: 'audio-transcribe' })(`${API_ROOT}/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ fileData: { mimeType: file.mimeType || mimeType, fileUri: file.uri } }] }],
          generationConfig: { audioTranscriptionConfig: { languageCodes, mode } },
        }),
        signal,
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const error = new Error(clip(payload.error?.message) || `转写失败 (${response.status})`);
        if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(error.message)) error.code = 'quota';
        throw error;
      }
      const text = readAudioTranscript(payload);
      if (!text) throw new Error('转写结果为空');
      return text;
    } finally {
      if (file.name) {
        await fetchImpl(`${API_ROOT}/v1beta/${file.name}`, {
          method: 'DELETE',
          headers: { 'x-goog-api-key': secret },
        }).catch(() => {});
      }
    }
  };
}
