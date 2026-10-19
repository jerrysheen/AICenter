import { spawnSync } from 'node:child_process';
import { isMain } from '../packages/runtime/src/is-main.js';

function found(command) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0;
}

export function ytDlpStatus() {
  return {
    ytDlp: found(process.env.AI_CENTER_YT_DLP || 'yt-dlp'),
    ffmpeg: found('ffmpeg'),
  };
}

if (isMain(import.meta.url)) {
  const status = ytDlpStatus();
  console.log(JSON.stringify(status));
  if (!status.ytDlp || !status.ffmpeg) {
    console.log('Windows 可运行 scripts/ensure-yt-dlp.ps1。也可以把 yt-dlp 放到 PATH，或设置 AI_CENTER_YT_DLP。');
    process.exitCode = 1;
  }
}
