import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummaryText, readAccessSummary } from '../apps/web/src/http/access-log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readArgs(argv) {
  const out = { date: '', since: '', top: '', dir: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--')) {
      console.error(`未知参数 ${key}`);
      return null;
    }
    if (value == null || value.startsWith('--')) {
      console.error(`缺少 ${key} 的值`);
      return null;
    }
    if (key === '--date') out.date = value;
    else if (key === '--since') out.since = value;
    else if (key === '--top') out.top = value;
    else if (key === '--dir') out.dir = value;
    else {
      console.error(`未知参数 ${key}`);
      return null;
    }
    index += 1;
  }
  return out;
}

const args = readArgs(process.argv);
if (!args) {
  process.exitCode = 1;
} else {
  const directory = args.dir ? path.resolve(args.dir) : path.join(root, 'data', 'logs');
  const summary = await readAccessSummary(directory, {
    date: args.date,
    since: args.since,
    top: args.top,
  });
  if (!summary.ok) {
    console.error(summary.error);
    process.exitCode = 1;
  } else {
    console.log(formatSummaryText(summary));
  }
}
