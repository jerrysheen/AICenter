/**
 * Official `@deepseek-ai/dsh` only calls `runCli()` when `import.meta.main` is
 * true. Loading the CLI from this file leaves that flag false, so the SDK
 * child would print nothing and exit 0. Always boot.
 *
 * Session persistence imports `node:zlib` zstd helpers (Node >= 22.15).
 * This Instance runs Node 22.23, so the real zlib is used and undici can
 * decode zstd. On older Node, register a shim before those plugins load.
 * The loader only rewrites `@deepseek-ai/*` imports. undici keeps real
 * `node:zlib`: a stub `createZstdDecompress` makes fetch advertise zstd and
 * then crash native web_fetch.
 */
import { register } from 'node:module';
import * as zlib from 'node:zlib';

if (typeof zlib.createZstdCompress !== 'function') {
  register(new URL('./dsh-zlib-loader.js', import.meta.url).href);
}

const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js');
await runCli();
