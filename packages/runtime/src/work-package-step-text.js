const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const UTF8 = new TextDecoder('utf-8');

let gbkDecoder = null;

function decoderForGbk() {
  if (gbkDecoder) return gbkDecoder;
  try {
    gbkDecoder = new TextDecoder('gbk');
  } catch {
    try {
      gbkDecoder = new TextDecoder('gb18030');
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder;
}

export function workPackageStepTextLooksGarbled(value) {
  return /\uFFFD/.test(String(value || ''));
}

export function decodeWorkPackageStepLine(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) return '';
  try {
    return UTF8_FATAL.decode(buffer);
  } catch {
    const gbk = decoderForGbk();
    if (gbk) return gbk.decode(buffer);
    return UTF8.decode(buffer);
  }
}

export function splitWorkPackageStepRecords(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 0x0a) continue;
    let end = index;
    if (end > start && source[end - 1] === 0x0d) end -= 1;
    if (end > start) lines.push(source.subarray(start, end));
    start = index + 1;
  }
  if (start < source.length) lines.push(source.subarray(start));
  return lines.map((line) => decodeWorkPackageStepLine(line)).filter((line) => line.trim());
}
