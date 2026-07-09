(function () {
  const VERSION_INFO = [
    null,
    { version: 1, size: 21, dataCodewords: 19, eccCodewords: 7 },
    { version: 2, size: 25, dataCodewords: 34, eccCodewords: 10 },
    { version: 3, size: 29, dataCodewords: 55, eccCodewords: 15 },
    { version: 4, size: 33, dataCodewords: 80, eccCodewords: 20 },
    { version: 5, size: 37, dataCodewords: 108, eccCodewords: 26 },
  ];

  const EXP = new Array(512);
  const LOG = new Array(256);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

  function gfMultiply(left, right) {
    if (left === 0 || right === 0) return 0;
    return EXP[LOG[left] + LOG[right]];
  }

  function rsGenerator(degree) {
    let polynomial = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(polynomial.length + 1).fill(0);
      for (let j = 0; j < polynomial.length; j += 1) {
        next[j] ^= polynomial[j];
        next[j + 1] ^= gfMultiply(polynomial[j], EXP[i]);
      }
      polynomial = next;
    }
    return polynomial;
  }

  function rsRemainder(data, degree) {
    const generator = rsGenerator(degree);
    const result = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i += 1) {
        result[i] ^= gfMultiply(generator[i + 1], factor);
      }
    }
    return result;
  }

  function appendBits(bits, number, length) {
    for (let i = length - 1; i >= 0; i -= 1) bits.push(((number >>> i) & 1) !== 0);
  }

  function chooseVersion(bytes) {
    for (const info of VERSION_INFO.slice(1)) {
      const neededBits = 4 + 8 + bytes.length * 8;
      if (neededBits <= info.dataCodewords * 8) return info;
    }
    throw new Error("QR linki çok uzun.");
  }

  function makeCodewords(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const info = chooseVersion(bytes);
    const bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, 8);
    for (const byte of bytes) appendBits(bits, byte, 8);

    const capacityBits = info.dataCodewords * 8;
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(false);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ? 1 : 0);
      data.push(byte);
    }

    for (let pad = 0xec; data.length < info.dataCodewords; pad ^= 0xfd) data.push(pad);
    return { info, codewords: data.concat(rsRemainder(data, info.eccCodewords)) };
  }

  function createMatrix(info) {
    const modules = Array.from({ length: info.size }, () => new Array(info.size).fill(null));
    const fixed = Array.from({ length: info.size }, () => new Array(info.size).fill(false));

    function inBounds(x, y) {
      return x >= 0 && y >= 0 && x < info.size && y < info.size;
    }

    function setFixed(x, y, dark) {
      if (!inBounds(x, y)) return;
      modules[y][x] = Boolean(dark);
      fixed[y][x] = true;
    }

    function drawFinder(x, y) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          const onPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const border = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const center = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          setFixed(xx, yy, onPattern && (border || center));
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(info.size - 7, 0);
    drawFinder(0, info.size - 7);

    for (let i = 8; i < info.size - 8; i += 1) {
      setFixed(i, 6, i % 2 === 0);
      setFixed(6, i, i % 2 === 0);
    }

    if (info.version > 1) {
      const center = info.size - 7;
      drawAlignment(center, center);
    }

    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) {
        setFixed(8, i, false);
        setFixed(i, 8, false);
      }
    }
    for (let i = info.size - 8; i < info.size; i += 1) {
      setFixed(8, i, false);
      setFixed(i, 8, false);
    }
    setFixed(8, info.size - 8, true);

    return { modules, fixed, setFixed };
  }

  function placeData(matrix, codewords) {
    const { modules, fixed } = matrix;
    const size = modules.length;
    let bitIndex = 0;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      for (let vert = 0; vert < size; vert += 1) {
        const y = upward ? size - 1 - vert : vert;
        for (let x = right; x > right - 2; x -= 1) {
          if (fixed[y][x]) continue;
          const byte = codewords[Math.floor(bitIndex / 8)] || 0;
          modules[y][x] = ((byte >>> (7 - (bitIndex % 8))) & 1) !== 0;
          bitIndex += 1;
        }
      }
      upward = !upward;
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return false;
    }
  }

  function formatBits(mask) {
    const data = (1 << 3) | mask;
    let bits = data << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if (((bits >>> i) & 1) !== 0) bits ^= 0x537 << (i - 10);
    }
    return ((data << 10) | (bits & 0x3ff)) ^ 0x5412;
  }

  function drawFormat(matrix, mask) {
    const { modules, fixed } = matrix;
    const size = modules.length;
    const bits = formatBits(mask);

    function set(x, y, index) {
      modules[y][x] = ((bits >>> index) & 1) !== 0;
      fixed[y][x] = true;
    }

    for (let i = 0; i <= 5; i += 1) set(8, i, i);
    set(8, 7, 6);
    set(8, 8, 7);
    set(7, 8, 8);
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, i);
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, i);
    modules[size - 8][8] = true;
    fixed[size - 8][8] = true;
  }

  function applyMask(matrix, mask) {
    const { modules, fixed } = matrix;
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (!fixed[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules) {
    const size = modules.length;
    let score = 0;

    function scanLine(get) {
      let runColor = get(0);
      let runLength = 1;
      for (let i = 1; i < size; i += 1) {
        const color = get(i);
        if (color === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColor = color;
          runLength = 1;
        }
      }
    }

    for (let y = 0; y < size; y += 1) scanLine((x) => modules[y][x]);
    for (let x = 0; x < size; x += 1) scanLine((y) => modules[y][x]);

    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3;
      }
    }

    const patterns = ["10111010000", "00001011101"];
    for (let y = 0; y < size; y += 1) {
      const row = modules[y].map((cell) => (cell ? "1" : "0")).join("");
      for (const pattern of patterns) {
        let index = row.indexOf(pattern);
        while (index !== -1) {
          score += 40;
          index = row.indexOf(pattern, index + 1);
        }
      }
    }
    for (let x = 0; x < size; x += 1) {
      let col = "";
      for (let y = 0; y < size; y += 1) col += modules[y][x] ? "1" : "0";
      for (const pattern of patterns) {
        let index = col.indexOf(pattern);
        while (index !== -1) {
          score += 40;
          index = col.indexOf(pattern, index + 1);
        }
      }
    }

    const dark = modules.flat().filter(Boolean).length;
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function buildMatrix(text) {
    const { info, codewords } = makeCodewords(text);
    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      const matrix = createMatrix(info);
      placeData(matrix, codewords);
      applyMask(matrix, mask);
      drawFormat(matrix, mask);
      const currentPenalty = penalty(matrix.modules);
      if (!best || currentPenalty < best.penalty) best = { modules: matrix.modules, penalty: currentPenalty };
    }
    return best.modules;
  }

  function toSvg(modules, options = {}) {
    const quiet = options.quiet ?? 4;
    const size = modules.length + quiet * 2;
    const paths = [];
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (modules[y][x]) paths.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
      }
    }
    return `
      <svg class="qr-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR kod">
        <rect width="100%" height="100%" fill="#fff"/>
        <path d="${paths.join("")}" fill="#111"/>
      </svg>
    `;
  }

  window.QrCode = {
    render(text, target, options = {}) {
      target.innerHTML = toSvg(buildMatrix(text), options);
    },
    svg(text, options = {}) {
      return toSvg(buildMatrix(text), options);
    },
  };
})();
