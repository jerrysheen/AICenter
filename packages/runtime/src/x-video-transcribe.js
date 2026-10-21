import { createGeminiAudioTranscriber } from '../../connectors/src/audio-transcribe.js';
import { createGeminiLiveTranscriber } from '../../connectors/src/audio-transcribe-live.js';

// 只把 #194 的转写函数装进 X 视频任务。分块、限速和失败回退仍由 executeAudioTranscription 做。
export function assembleXVideoTranscribeDeps(options = {}) {
  const env = options.env || process.env;
  const injected = typeof options.geminiTranscribe === 'function';
  return {
    ...options,
    env,
    geminiTranscribe: injected ? options.geminiTranscribe : createGeminiLiveTranscriber({ env }),
    geminiFileTranscribe: options.geminiFileTranscribe !== undefined
      ? options.geminiFileTranscribe
      : (injected ? null : createGeminiAudioTranscriber({ env })),
  };
}
