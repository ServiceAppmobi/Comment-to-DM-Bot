/**
 * Pure JavaScript ISO/IEC 18004 QR Code encoder (Byte mode, Versions 1–12).
 * Zero external dependencies — works 100% offline in browser and Node.js.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j++) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return rem;
}

// Alignment pattern center coordinates for versions 1..12
const ALIGNMENT_COORDS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
};

// Format: [version, ecLevelBits, ecPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
// ecLevelBits: M = 0 (00), L = 1 (01)
const VERSION_SPECS_M = [
  [1, 0, 10, [[1, 16]]],
  [2, 0, 16, [[1, 28]]],
  [3, 0, 26, [[1, 44]]],
  [4, 0, 18, [[2, 32]]],
  [5, 0, 24, [[2, 43]]],
  [6, 0, 16, [[4, 27]]],
  [7, 0, 18, [[4, 31]]],
  [8, 0, 22, [[2, 38], [2, 39]]],
  [9, 0, 22, [[3, 36], [2, 37]]],
  [10, 0, 26, [[4, 43], [1, 44]]],
];

const VERSION_SPECS_L = [
  [1, 1, 7, [[1, 19]]],
  [2, 1, 10, [[1, 34]]],
  [3, 1, 15, [[1, 55]]],
  [4, 1, 20, [[1, 80]]],
  [5, 1, 26, [[1, 108]]],
  [6, 1, 18, [[2, 68]]],
  [7, 1, 20, [[2, 78]]],
  [8, 1, 24, [[2, 97]]],
  [9, 1, 30, [[2, 116]]],
  [10, 1, 18, [[2, 68], [2, 69]]],
  [11, 1, 20, [[4, 81]]],
  [12, 1, 24, [[2, 92], [2, 93]]],
];

function totalDataBytes(spec) {
  return spec[3].reduce((sum, [count, size]) => sum + count * size, 0);
}

function selectSpec(byteLength, preferLevel = 'M') {
  const candidates = preferLevel === 'L' ? VERSION_SPECS_L : [...VERSION_SPECS_M, ...VERSION_SPECS_L];
  for (const spec of candidates) {
    const version = spec[0];
    const countBits = version <= 9 ? 8 : 16;
    const overheadBits = 4 + countBits;
    const capacityBits = totalDataBytes(spec) * 8;
    if (overheadBits + byteLength * 8 <= capacityBits) {
      return spec;
    }
  }
  throw new Error('Tekst jest zbyt długi dla kodu QR (maks. ~365 bajtów UTF-8).');
}

function encodeDataCodewords(bytes, spec) {
  const version = spec[0];
  const totalBytes = totalDataBytes(spec);
  const bits = [];

  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  // Character count
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  // Payload bytes
  for (const b of bytes) {
    pushBits(b, 8);
  }
  // Terminator (up to 4 zero bits)
  const capacityBits = totalBytes * 8;
  const termLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    codewords.push(byte);
  }

  // Pad codewords 0xEC, 0x11
  let padToggle = 0;
  while (codewords.length < totalBytes) {
    codewords.push(padToggle === 0 ? 0xec : 0x11);
    padToggle ^= 1;
  }

  return codewords;
}

function interleaveBlocks(dataCodewords, spec) {
  const ecPerBlock = spec[2];
  const groups = spec[3];

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (const [blockCount, blockLen] of groups) {
    for (let b = 0; b < blockCount; b++) {
      const slice = dataCodewords.slice(offset, offset + blockLen);
      offset += blockLen;
      dataBlocks.push(slice);
      ecBlocks.push(rsCompute(slice, ecPerBlock));
    }
  }

  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i]);
    }
  }

  return result;
}

function computeFormatBits(ecLevelBits, maskPattern) {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function computeVersionBits(version) {
  let rem = version << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) {
      rem ^= poly << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function buildMatrix(version, ecLevelBits, allCodewords) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunction = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  // Finder patterns + 1-module white separator
  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunction(r, c, inOuter && (isBorder || isCenter));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_COORDS[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      // Skip if overlapping finder patterns
      const nearTopLeft = r <= 8 && c <= 8;
      const nearTopRight = r <= 8 && c >= size - 9;
      const nearBottomLeft = r >= size - 9 && c <= 8;
      if (nearTopLeft || nearTopRight || nearBottomLeft) continue;

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunction(r + dr, c + dc, dist === 2 || dist === 0);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunction(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i++) {
    setFunction(size - 1 - i, 8, false);
  }
  setFunction(size - 8, 8, true);

  // Version info for version >= 7
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((vBits >> i) & 1);
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  // Place data bits in upward/downward 2-column zigzag
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (!isFunction[r][c]) {
          let dark = 0;
          if (bitIdx < totalBits) {
            const byte = allCodewords[bitIdx >> 3];
            dark = (byte >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          modules[r][c] = dark;
        }
      }
    }
    upward = !upward;
  }

  // Evaluate 8 mask patterns and choose lowest penalty
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const applyFormat = (grid, maskIdx) => {
    const fBits = computeFormatBits(ecLevelBits, maskIdx);
    // Bit 14 is MSB, placed at (8,0) / (size-1,8)
    for (let i = 0; i < 6; i++) {
      grid[8][i] = (fBits >> (14 - i)) & 1;
    }
    grid[8][7] = (fBits >> 8) & 1;
    grid[8][8] = (fBits >> 7) & 1;
    grid[7][8] = (fBits >> 6) & 1;
    for (let i = 0; i < 6; i++) {
      grid[5 - i][8] = (fBits >> (5 - i)) & 1;
    }

    for (let i = 0; i < 7; i++) {
      grid[size - 1 - i][8] = (fBits >> (14 - i)) & 1;
    }
    for (let i = 0; i < 8; i++) {
      grid[8][size - 8 + i] = (fBits >> (7 - i)) & 1;
    }
  };

  const scorePenalty = (grid) => {
    let penalty = 0;
    // Rule 1: consecutive runs >= 5
    for (let r = 0; r < size; r++) {
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runLen = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (grid[r][c] === grid[r - 1][c]) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runLen = 1;
        }
      }
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }
    // Rule 4: dark ratio balance
    let darkCount = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c]) darkCount++;
      }
    }
    const pct = (darkCount * 100) / (size * size);
    const k = Math.floor(Math.abs(pct - 50) / 5);
    penalty += k * 10;
    return penalty;
  };

  let bestGrid = null;
  let bestScore = Infinity;

  for (let m = 0; m < 8; m++) {
    const candidate = modules.map((row) => new Uint8Array(row));
    const maskFn = maskFns[m];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && maskFn(r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    applyFormat(candidate, m);
    const s = scorePenalty(candidate);
    if (s < bestScore) {
      bestScore = s;
      bestGrid = candidate;
    }
  }

  return bestGrid;
}

export function generateQrMatrix(text, { level = 'M' } = {}) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const spec = selectSpec(bytes.length, level);
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const allCodewords = interleaveBlocks(dataCodewords, spec);
  const matrix = buildMatrix(spec[0], spec[1], allCodewords);
  return {
    version: spec[0],
    size: matrix.length,
    matrix,
  };
}

export function generateQrSvg(text, options = {}) {
  const {
    margin = 4,
    darkColor = '#0f172a',
    lightColor = '#ffffff',
    pixelSize = 240,
    level = 'M',
  } = options;

  const { size, matrix } = generateQrMatrix(text, { level });
  const total = size + margin * 2;
  const paths = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img" aria-label="Kod QR Click-to-WhatsApp">`,
    `<rect width="${total}" height="${total}" fill="${lightColor}"/>`,
    `<path d="${paths.join('')}" fill="${darkColor}"/>`,
    `</svg>`,
  ].join('');
}
