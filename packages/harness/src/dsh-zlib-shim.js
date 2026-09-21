export * from 'node:zlib';

function zstdUnavailable(name) {
  return () => {
    throw new Error(`${name} 需要 Node.js >= 22.15；AI Center Harness 会话日志使用 compression: none`);
  };
}

export const createZstdCompress = zstdUnavailable('createZstdCompress');
export const createZstdDecompress = zstdUnavailable('createZstdDecompress');
export const zstdCompress = zstdUnavailable('zstdCompress');
export const zstdDecompress = zstdUnavailable('zstdDecompress');
export const zstdDecompressSync = zstdUnavailable('zstdDecompressSync');
export const zstdCompressSync = zstdUnavailable('zstdCompressSync');
