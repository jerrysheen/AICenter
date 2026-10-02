import fs from 'node:fs';
import path from 'node:path';
import { MediaConfigSchema } from '../../contracts/src/media.js';

export function loadMediaConfig(configDirectory) {
  const file = path.join(configDirectory, 'media.json');
  return MediaConfigSchema.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, sources: [] });
}
