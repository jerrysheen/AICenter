import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { FeedValueCalibrationSchema } from '../../contracts/src/feed-value.js';

// Composition roots inject calibration; Domain never reads Host files.
export function loadFeedValueCalibration(instance) {
  const file=path.join(instance.runtimeDirectory,'feed-value-calibration.json');
  if(!existsSync(file)) return null;
  try { const parsed=FeedValueCalibrationSchema.safeParse(JSON.parse(readFileSync(file,'utf8')));
    return parsed.success?parsed.data:null;
  } catch { return null; }
}

export function loadFeedValueScoreCache(instance) {
  const file=path.join(instance.runtimeDirectory,'feed-value-score-cache.json');
  try {return JSON.parse(readFileSync(file,'utf8'));} catch {return null;}
}
