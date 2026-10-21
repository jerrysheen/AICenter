import { createGeminiAudioTranscriber } from '../../connectors/src/audio-transcribe.js';
import { createGeminiLiveTranscriber } from '../../connectors/src/audio-transcribe-live.js';
import { resolveAudioTranscribeModels } from '../../domain/src/audio-transcription.js';

// Worker 装配 X 视频整理时用。Live 优先，文件转写只在 Live 失败后使用。
export function assembleXVideoTranscribeDeps(options = {}) {
  const env = options.env || process.env;
  const models = resolveAudioTranscribeModels(env);
  const geminiTranscribe = typeof options.geminiTranscribe === 'function'
    ? options.geminiTranscribe
    : createGeminiLiveTranscriber({ env, model: models.live });
  const geminiFileTranscribe = typeof options.geminiFileTranscribe === 'function'
    ? options.geminiFileTranscribe
    : createGeminiAudioTranscriber({ env, model: models.file });
  if (typeof geminiTranscribe !== 'function') throw new Error('transcribe is not a function');
  return { ...options, env, geminiTranscribe, geminiFileTranscribe };
}
