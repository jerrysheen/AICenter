// Offline QR encoder (byte mode, ECC M, versions 1–6). No network and no image service.

const CODEWORDS = [0, 26, 44, 70, 100, 134, 172];
const EC_CODEWORDS_M = [10, 16, 26, 36, 48, 64];
const EC_BLOCKS_M = [1, 1, 1, 2, 2, 4];
const ECC_M_BIT = 0;
const MAX_VERSION = 6;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polyMul(p1, p2) {
  const coeff = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i += 1) {
    for (let j = 0; j < p2.length; j += 1) coeff[i + j] ^= gfMul(p1[i], p2[j]);
  }
  return coeff;
}

function polyMod(dividend, divisor) {
  let result = new Uint8Array(dividend);
  while (result.length - divisor.length >= 0) {
    const coeff = result[0];
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= gfMul(divisor[i], coeff);
    let offset = 0;
    while (offset < result.length && result[offset] === 0) offset += 1;
    result = result.slice(offset);
  }
  return result;
}

function ecPolynomial(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) poly = polyMul(poly, new Uint8Array([1, EXP[i]]));
  return poly;
}

const GENERATORS = new Map();

function rsEncode(data, degree) {
  let gen = GENERATORS.get(degree);
  if (!gen) {
    gen = ecPolynomial(degree);
    GENERATORS.set(degree, gen);
  }
  const padded = new Uint8Array(data.length + degree);
  padded.set(data);
  const remainder = polyMod(padded, gen);
  if (remainder.length >= degree) return remainder.slice(remainder.length - degree);
  const out = new Uint8Array(degree);
  out.set(remainder, degree - remainder.length);
  return out;
}

function bchDigit(data) {
  let digit = 0;
  let value = data >>> 0;
  while (value !== 0) {
    digit += 1;
    value >>>= 1;
  }
  return digit;
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G15_BCH = bchDigit(G15);

function formatBits(mask) {
  const data = (ECC_M_BIT << 3) | mask;
  let rest = data << 10;
  while (bchDigit(rest) - G15_BCH >= 0) rest ^= G15 << (bchDigit(rest) - G15_BCH);
  return ((data << 10) | rest) ^ G15_MASK;
}

function symbolSize(version) {
  return 21 + (version - 1) * 4;
}

function alignmentCoords(version) {
  if (version < 2) return [];
  const size = symbolSize(version);
  const posCount = Math.floor(version / 7) + 2;
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i += 1) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function alignmentPositions(version) {
  const pos = alignmentCoords(version);
  const coords = [];
  for (let i = 0; i < pos.length; i += 1) {
    for (let j = 0; j < pos.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      coords.push([pos[i], pos[j]]);
    }
  }
  return coords;
}

function dataCapacity(version) {
  return CODEWORDS[version] - EC_CODEWORDS_M[version - 1];
}

function chooseVersion(byteLength) {
  const bits = 4 + 8 + byteLength * 8;
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (bits <= dataCapacity(version) * 8) return version;
  }
  throw new Error('链接过长，无法生成二维码');
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function encodeData(bytes, version) {
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  const capacity = dataCapacity(version) * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacity) {
    pushBits(bits, pad[padIndex % 2], 8);
    padIndex += 1;
  }
  const data = new Uint8Array(bits.length / 8);
  for (let i = 0; i < data.length; i += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[i * 8 + bit];
    data[i] = value;
  }
  return data;
}

function interleave(data, version) {
  const total = CODEWORDS[version];
  const ecTotal = EC_CODEWORDS_M[version - 1];
  const dataTotal = total - ecTotal;
  const blocks = EC_BLOCKS_M[version - 1];
  const group2 = total % blocks;
  const group1 = blocks - group2;
  const data1 = Math.floor(dataTotal / blocks);
  const data2 = data1 + 1;
  const ecCount = Math.floor(total / blocks) - data1;
  const dc = [];
  const ec = [];
  let offset = 0;
  let maxData = 0;
  for (let block = 0; block < blocks; block += 1) {
    const size = block < group1 ? data1 : data2;
    const slice = data.slice(offset, offset + size);
    dc.push(slice);
    ec.push(rsEncode(slice, ecCount));
    offset += size;
    maxData = Math.max(maxData, size);
  }
  const out = new Uint8Array(total);
  let index = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let block = 0; block < blocks; block += 1) {
      if (i < dc[block].length) out[index++] = dc[block][i];
    }
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (let block = 0; block < blocks; block += 1) out[index++] = ec[block][i];
  }
  return out;
}

function createMatrix(version) {
  const size = symbolSize(version);
  return {
    size,
    modules: new Uint8Array(size * size),
    reserved: new Uint8Array(size * size),
  };
}

function at(matrix, row, col) {
  return row * matrix.size + col;
}

function setModule(matrix, row, col, value, reserved = false) {
  if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size) return;
  const index = at(matrix, row, col);
  matrix.modules[index] = value ? 1 : 0;
  if (reserved) matrix.reserved[index] = 1;
}

function placeFinders(matrix) {
  const anchors = [[0, 0], [matrix.size - 7, 0], [0, matrix.size - 7]];
  for (const [row, col] of anchors) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(matrix, row + r, col + c, dark, true);
      }
    }
  }
}

function placeTiming(matrix) {
  for (let i = 8; i < matrix.size - 8; i += 1) {
    const dark = i % 2 === 0;
    setModule(matrix, i, 6, dark, true);
    setModule(matrix, 6, i, dark, true);
  }
}

function placeAlignment(matrix, version) {
  for (const [row, col] of alignmentPositions(version)) {
    for (let r = -2; r <= 2; r += 1) {
      for (let c = -2; c <= 2; c += 1) {
        const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        setModule(matrix, row + r, col + c, dark, true);
      }
    }
  }
}

function placeFormat(matrix, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) setModule(matrix, i, 8, dark, true);
    else if (i < 8) setModule(matrix, i + 1, 8, dark, true);
    else setModule(matrix, matrix.size - 15 + i, 8, dark, true);
    if (i < 8) setModule(matrix, 8, matrix.size - i - 1, dark, true);
    else if (i < 9) setModule(matrix, 8, 15 - i - 1 + 1, dark, true);
    else setModule(matrix, 8, 15 - i - 1, dark, true);
  }
  setModule(matrix, matrix.size - 8, 8, true, true);
}

function placeData(matrix, codewords) {
  const size = matrix.size;
  let upward = true;
  let row = size - 1;
  let byteIndex = 0;
  let bitIndex = 7;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const x = col - c;
        if (!matrix.reserved[at(matrix, row, x)]) {
          const dark = byteIndex < codewords.length && ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          setModule(matrix, row, x, dark, false);
          bitIndex -= 1;
          if (bitIndex < 0) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
      }
      if (upward) {
        if (row === 0) {
          upward = false;
          break;
        }
        row -= 1;
      } else if (row === size - 1) {
        upward = true;
        break;
      } else row += 1;
    }
  }
}

function maskAt(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
  }
}

function applyMask(matrix, pattern) {
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      const index = at(matrix, row, col);
      if (matrix.reserved[index]) continue;
      if (maskAt(pattern, row, col)) matrix.modules[index] ^= 1;
    }
  }
}

function penalty(matrix) {
  const size = matrix.size;
  const get = (row, col) => matrix.modules[at(matrix, row, col)];
  let points = 0;
  for (let row = 0; row < size; row += 1) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol = null;
    let lastRow = null;
    for (let col = 0; col < size; col += 1) {
      let module = get(row, col);
      if (module === lastCol) sameCol += 1;
      else {
        if (sameCol >= 5) points += 3 + (sameCol - 5);
        lastCol = module;
        sameCol = 1;
      }
      module = get(col, row);
      if (module === lastRow) sameRow += 1;
      else {
        if (sameRow >= 5) points += 3 + (sameRow - 5);
        lastRow = module;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const sum = get(row, col) + get(row, col + 1) + get(row + 1, col) + get(row + 1, col + 1);
      if (sum === 0 || sum === 4) points += 3;
    }
  }
  for (let row = 0; row < size; row += 1) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col += 1) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | get(row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
      bitsRow = ((bitsRow << 1) & 0x7ff) | get(col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
    }
  }
  let dark = 0;
  for (const module of matrix.modules) dark += module;
  const k = Math.abs(Math.ceil((dark * 100 / matrix.modules.length) / 5) - 10);
  return points + k * 10;
}

function toRows(matrix) {
  const rows = [];
  for (let row = 0; row < matrix.size; row += 1) {
    rows.push(Array.from(matrix.modules.slice(row * matrix.size, (row + 1) * matrix.size)));
  }
  return rows;
}

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  if (!bytes.length) throw new Error('没有可编码的链接');
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);
  const matrix = createMatrix(version);
  placeFinders(matrix);
  placeTiming(matrix);
  placeAlignment(matrix, version);
  placeFormat(matrix, 0);
  placeData(matrix, codewords);
  let best = 0;
  let bestScore = Infinity;
  for (let pattern = 0; pattern < 8; pattern += 1) {
    placeFormat(matrix, pattern);
    applyMask(matrix, pattern);
    const score = penalty(matrix);
    applyMask(matrix, pattern);
    if (score < bestScore) {
      bestScore = score;
      best = pattern;
    }
  }
  placeFormat(matrix, best);
  applyMask(matrix, best);
  return toRows(matrix);
}

export function paintQr(context, matrix, x, y, size, quiet = 4) {
  const modules = matrix.length + quiet * 2;
  const cell = size / modules;
  context.fillStyle = '#ffffff';
  context.fillRect(x, y, size, size);
  context.fillStyle = '#1b2028';
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix.length; col += 1) {
      if (!matrix[row][col]) continue;
      const left = x + (col + quiet) * cell;
      const top = y + (row + quiet) * cell;
      context.fillRect(left, top, cell + 0.35, cell + 0.35);
    }
  }
}
