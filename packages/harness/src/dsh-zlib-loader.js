export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:zlib' || specifier === 'zlib') {
    const parent = String(context.parentURL || '');
    if (parent.includes('dsh-zlib-shim')) {
      return nextResolve(specifier, context);
    }
    // Only DeepSeek Harness plugins import Node 22.15 zstd names at load time.
    // undici must keep the real node:zlib: a function-valued createZstdDecompress
    // makes fetch request zstd and crash native web_fetch on Node 22.14.
    if (parent.includes('@deepseek-ai/') || parent.includes('dsh-session')) {
      return {
        shortCircuit: true,
        url: new URL('./dsh-zlib-shim.js', import.meta.url).href,
      };
    }
  }
  return nextResolve(specifier, context);
}
