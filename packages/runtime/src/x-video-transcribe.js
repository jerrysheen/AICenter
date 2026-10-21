import { executeAudioTranscription } from './audio-transcription-job.js';

// deps.geminiTranscribe 就是 #194 的 executeAudioTranscription。
// 不传入 transcribe / fileTranscribe，这一层才会先走 Live，失败才用文件转写。
export function assembleXVideoTranscribeDeps(options = {}) {
  const env = options.env || process.env;
  const geminiTranscribe = typeof options.geminiTranscribe === 'function'
    ? options.geminiTranscribe
    : (request = {}) => executeAudioTranscription({
      input: request.input,
      dataDirectory: request.dataDirectory,
      env: request.env || env,
      quotaRepository: request.quotaRepository,
      now: request.now,
      sleep: request.sleep,
      signal: request.signal,
    });
  return { ...options, env, geminiTranscribe };
}
