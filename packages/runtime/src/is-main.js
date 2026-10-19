import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compare the running script with import.meta.url. On Windows, file URLs use
// drive letters and the argv path may use backslashes or a different case.
export function isMain(metaUrl, argvPath = process.argv[1], platform = process.platform) {
  if (!metaUrl || !argvPath) return false;
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path;
  let left = '';
  try {
    left = pathApi.resolve(fileURLToPath(metaUrl, { windows }));
  } catch {
    return false;
  }
  const right = pathApi.resolve(String(argvPath));
  if (windows) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}
