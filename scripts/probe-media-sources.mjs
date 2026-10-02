import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { loadMediaConfig } from '../packages/instance/src/media-config.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
const config = loadMediaConfig(resolveInstanceConfig({ repositoryRoot: process.cwd() }).configDirectory);
const MEDIA_SOURCES = config.sources;
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
};

if (has('--help')) {
  console.log(`Usage: node scripts/probe-media-sources.mjs [--run --policy-reviewed --sources dcd,bbc]
Default is dry-run. It does not read the database, environment secrets, or article bodies.
--policy-reviewed records that the operator checked access rules. It is not a content license.`);
  process.exit(0);
}

const requested = (valueOf('--sources') || '').split(',').map((item) => item.trim()).filter(Boolean);
const sourceKeys = requested.length ? requested : MEDIA_SOURCES.map((entry) => entry.sourceKey);
const service = createMediaIngestionService({
  mediaPort: createMediaConnector(config),
  mediaRepository: {
    listStates() { return []; },
    getState() { return null; },
    saveState(state) { return state; },
  },
});
const probe = await service.probe({
  sourceKeys,
  policyReviewed: has('--policy-reviewed'),
  run: has('--run'),
});
console.log(JSON.stringify(probe, null, 2));
