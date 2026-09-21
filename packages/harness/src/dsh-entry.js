/**
 * Official `@deepseek-ai/dsh` only calls `runCli()` when `import.meta.main` is
 * true. That field landed in Node 22.18; this Instance still runs 22.14, so
 * the SDK child would load the CLI, print nothing, and exit 0. Always boot.
 *
 * Session persistence imports `node:zlib`'s zstd helpers (Node >= 22.15).
 * Register a shim first so 22.14 can load those plugins; overlay sets
 * `compression: none` so the stubs are not used. The loader only rewrites
 * `@deepseek-ai/*` imports. undici keeps real `node:zlib` (no zstd on 22.14)
 * so native web_fetch does not advertise or decode zstd.
 */
import { register } from 'node:module';
import * as zlib from 'node:zlib';

if (typeof zlib.createZstdCompress !== 'function') {
  register(new URL('./dsh-zlib-loader.js', import.meta.url).href);
}

const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js');
await runCli();
