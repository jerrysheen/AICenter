import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
export function createHardwareArtifactStore({ dataDirectory }) {
  return {
    save(raw, format) {
      const hash = createHash('sha256').update(raw).digest('hex');
      const relativePath = `blobs/hardware-prices/${hash}.${format === 'html' ? 'html' : 'txt'}`;
      const absolute = path.join(dataDirectory, relativePath);
      mkdirSync(path.dirname(absolute), { recursive:true });
      try { writeFileSync(absolute, raw, { encoding:'utf8', flag:'wx' }); } catch(e) { if(e.code !== 'EEXIST') throw e; }
      return { hash, relativePath };
    },
    read(relativePath) {
      if (!/^blobs\/hardware-prices\/[a-f0-9]{64}\.(html|txt)$/.test(relativePath)) throw new Error('invalid price artifact');
      return readFileSync(path.join(dataDirectory, relativePath), 'utf8');
    },
  };
}
