import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';

export function decodeUsageHistory(text, sessionId) {
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = JSON.parse(lines.shift());
  if (header.id !== sessionId || header.version !== 3) return [];
  // Use the released physical codec. Never rewrite/migrate a Harness log from accounting.
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'recoverable', validation: 'transformed' });
  for (const line of lines) restore.decodeRow(JSON.parse(line));
  return restore.finish().events;
}

export async function supplementHarnessUsage({ dshHome, sessionId, observer }) {
  try {
    if (!/^aicenter-[a-f0-9]+$/.test(sessionId) || !observer.hasIncomplete()) return;
    const turns = observer.knownTurns(sessionId);
    if (!turns.size) return; // An unobserved historical turn cannot be assigned to this business run.
    const root = path.join(dshHome, 'sessions');
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const directory = path.join(root, project.name, sessionId);
      let files;
      try { files = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      const file = files.find(file => file.isFile() && !file.isSymbolicLink() && ['session.v3.jsonl', 'session.v3.jsonl.zstd'].includes(file.name));
      if (!file) continue;
      const source = path.join(directory, file.name);
      if ((await stat(source)).size > 32 * 1024 * 1024) return;
      // The released backend owns concatenated Zstandard frames, torn-tail recovery,
      // physical codecs and identity validation. Reading acquires no write lease.
      const [{ Context }, { default: JsonlSessionPersistence }] = await Promise.all([
        import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
      ]);
      const context = new Context();
      let handle;
      try {
        const persistence = new JsonlSessionPersistence(context, { root, compression: file.name.endsWith('.zstd') ? 'zstd' : 'none' });
        handle = await persistence.open(sessionId, 'read');
        const { events } = await handle.read();
        observer.events(sessionId, events.filter(event => turns.has(event.data?.turn)));
      } finally { await handle?.close(); await context.fiber.dispose(); }
      return;
    }
  } catch { /* Missing, unsupported or corrupt histories stay explicitly incomplete. */ }
}
