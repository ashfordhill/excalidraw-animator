/**
 * A small, dependency-free GIF89a encoder for animation exports.
 *
 * Frames are quantized to a single global palette (median cut), which keeps
 * file sizes down and colors stable between frames. Only the LZW encoder and
 * byte writer need to be remotely fast, so they work on typed arrays.
 */

type RGB = [number, number, number];

const TABLE_SIZE = 256;
const MAX_LZW_CODE = 4096;

class ByteWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;

  private ensure(size: number) {
    if (this.length + size <= this.buffer.length) {
      return;
    }
    let nextSize = this.buffer.length * 2;
    while (nextSize < this.length + size) {
      nextSize *= 2;
    }
    const next = new Uint8Array(nextSize);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  writeByte(value: number) {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
  }

  writeBytes(values: Uint8Array) {
    this.ensure(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  writeUint16(value: number) {
    this.writeByte(value & 0xff);
    this.writeByte((value >> 8) & 0xff);
  }

  writeString(value: string) {
    for (let i = 0; i < value.length; i++) {
      this.writeByte(value.charCodeAt(i));
    }
  }

  finish() {
    return this.buffer.slice(0, this.length);
  }
}

class BitWriter {
  private bytes = new ByteWriter();
  private buffer = 0;
  private bitCount = 0;

  write(code: number, size: number) {
    this.buffer |= code << this.bitCount;
    this.bitCount += size;
    while (this.bitCount >= 8) {
      this.bytes.writeByte(this.buffer & 0xff);
      this.buffer >>>= 8;
      this.bitCount -= 8;
    }
  }

  finish() {
    if (this.bitCount > 0) {
      this.bytes.writeByte(this.buffer & 0xff);
    }
    return this.bytes.finish();
  }
}

const lzwEncode = (indices: Uint8Array, minCodeSize: number) => {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const dictionary = new Map<number, number>();

  writer.write(clearCode, codeSize);

  if (!indices.length) {
    writer.write(endCode, codeSize);
    return writer.finish();
  }

  let current = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    const key = (current << 8) | next;
    const code = dictionary.get(key);
    if (code !== undefined) {
      current = code;
      continue;
    }

    writer.write(current, codeSize);

    if (nextCode < MAX_LZW_CODE) {
      dictionary.set(key, nextCode++);
      if (nextCode > 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    } else {
      writer.write(clearCode, codeSize);
      dictionary.clear();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }

    current = next;
  }

  writer.write(current, codeSize);
  writer.write(endCode, codeSize);

  return writer.finish();
};

type ColorEntry = { r: number; g: number; b: number; count: number };

type ColorBox = {
  colors: ColorEntry[];
  count: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
};

const makeBox = (colors: ColorEntry[]): ColorBox => {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  let count = 0;
  for (const color of colors) {
    rMin = Math.min(rMin, color.r);
    rMax = Math.max(rMax, color.r);
    gMin = Math.min(gMin, color.g);
    gMax = Math.max(gMax, color.g);
    bMin = Math.min(bMin, color.b);
    bMax = Math.max(bMax, color.b);
    count += color.count;
  }
  return { colors, count, rMin, rMax, gMin, gMax, bMin, bMax };
};

const boxRange = (box: ColorBox) =>
  Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);

const splitBox = (box: ColorBox): [ColorBox, ColorBox] => {
  const rRange = box.rMax - box.rMin;
  const gRange = box.gMax - box.gMin;
  const bRange = box.bMax - box.bMin;
  const axis =
    rRange >= gRange && rRange >= bRange ? "r" : gRange >= bRange ? "g" : "b";
  const colors = [...box.colors].sort((a, b) => a[axis] - b[axis]);
  const half = box.count / 2;
  let accumulated = 0;
  let splitAt = 1;
  for (let i = 0; i < colors.length - 1; i++) {
    accumulated += colors[i].count;
    if (accumulated >= half) {
      splitAt = i + 1;
      break;
    }
  }
  const left = colors.slice(0, splitAt);
  const right = colors.slice(splitAt);
  return [makeBox(left), makeBox(right)];
};

const quantize = (entries: ColorEntry[], maxColors: number): RGB[] => {
  if (!entries.length) {
    return [[0, 0, 0]];
  }
  if (entries.length <= maxColors) {
    return entries.map(({ r, g, b }) => [r, g, b] as RGB);
  }

  let boxes = [makeBox(entries)];
  while (boxes.length < maxColors) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.colors.length < 2) {
        continue;
      }
      const score = boxRange(box);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) {
      break;
    }
    const [left, right] = splitBox(boxes[bestIndex]);
    boxes = [
      ...boxes.slice(0, bestIndex),
      left,
      right,
      ...boxes.slice(bestIndex + 1),
    ];
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const color of box.colors) {
      r += color.r * color.count;
      g += color.g * color.count;
      b += color.b * color.count;
      total += color.count;
    }
    return [
      Math.round(r / total),
      Math.round(g / total),
      Math.round(b / total),
    ] as RGB;
  });
};

const colorKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/**
 * Maps 5-bit color components to a palette index. Quantizing the lookup table
 * (instead of caching every exact RGB value) caps the cost of palette building
 * even for large, photographic scenes.
 */
const buildColorLookup = (palette: RGB[], offset: number) => {
  const lookup = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r++) {
    for (let g = 0; g < 32; g++) {
      for (let b = 0; b < 32; b++) {
        const rr = (r * 255) / 31;
        const gg = (g * 255) / 31;
        const bb = (b * 255) / 31;
        let bestIndex = offset;
        let bestDistance = Infinity;
        for (let i = offset; i < palette.length; i++) {
          const dr = rr - palette[i][0];
          const dg = gg - palette[i][1];
          const db = bb - palette[i][2];
          const distance = dr * dr + dg * dg + db * db;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
            if (distance === 0) {
              break;
            }
          }
        }
        lookup[(r << 10) | (g << 5) | b] = bestIndex;
      }
    }
  }
  return lookup;
};

const buildPalette = (
  frames: readonly Uint8ClampedArray[],
  transparent: boolean,
) => {
  const counts = new Map<number, number>();
  const pixelCount = frames.reduce(
    (total, frame) => total + frame.length / 4,
    0,
  );
  const step = Math.max(1, Math.floor(pixelCount / 250000));

  for (const frame of frames) {
    for (let pixel = 0; pixel < frame.length; pixel += 4 * step) {
      if (transparent && frame[pixel + 3] < 128) {
        continue;
      }
      const key = colorKey(frame[pixel], frame[pixel + 1], frame[pixel + 2]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // keep the histogram bounded for huge/multi-frame exports
  const maxEntries = 16_384;
  let entries: ColorEntry[] = [...counts.entries()].map(([key, count]) => ({
    r: (key >> 16) & 0xff,
    g: (key >> 8) & 0xff,
    b: key & 0xff,
    count,
  }));
  if (entries.length > maxEntries) {
    entries = entries.sort((a, b) => b.count - a.count).slice(0, maxEntries);
  }

  const colors = quantize(entries, transparent ? TABLE_SIZE - 1 : TABLE_SIZE);
  const palette: RGB[] = transparent ? [[0, 0, 0], ...colors] : [...colors];
  while (palette.length < TABLE_SIZE) {
    palette.push([0, 0, 0]);
  }
  return { palette };
};

const writeGlobalColorTable = (writer: ByteWriter, palette: RGB[]) => {
  for (let i = 0; i < TABLE_SIZE; i++) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    writer.writeByte(r);
    writer.writeByte(g);
    writer.writeByte(b);
  }
};

export type EncodeGifOptions = {
  width: number;
  height: number;
  /** RGBA pixel data, all frames must have the same dimensions */
  frames: readonly Uint8ClampedArray[];
  /** frame delay in hundredths of a second */
  delay: number;
  loop?: boolean;
  transparent?: boolean;
};

export type GifWriterOptions = {
  width: number;
  height: number;
  /** frame delay in hundredths of a second */
  delay: number;
  loop?: boolean;
  transparent?: boolean;
  /**
   * RGBA frames the global palette is sampled from. Pass a representative
   * subset to keep memory bounded when encoding long animations.
   */
  paletteFrames: readonly Uint8ClampedArray[];
};

export type GifWriter = {
  addFrame: (frame: Uint8ClampedArray) => void;
  finish: () => Uint8Array;
};

/**
 * Creates a GIF encoder that accepts frames one at a time, so callers don't
 * have to hold every RGBA frame in memory.
 */
export const createGifWriter = ({
  width,
  height,
  delay,
  loop = true,
  transparent = false,
  paletteFrames,
}: GifWriterOptions): GifWriter => {
  if (!paletteFrames.length) {
    throw new Error("Cannot encode a GIF without frames");
  }

  const { palette } = buildPalette(paletteFrames, transparent);
  const lookup = buildColorLookup(palette, transparent ? 1 : 0);
  const writer = new ByteWriter();

  writer.writeString("GIF89a");
  writer.writeUint16(width);
  writer.writeUint16(height);
  // global color table, 8-bit color resolution, 256 entries
  writer.writeByte(0xf7);
  writer.writeByte(0);
  writer.writeByte(0);
  writeGlobalColorTable(writer, palette);

  if (loop) {
    writer.writeByte(0x21);
    writer.writeByte(0xff);
    writer.writeByte(0x0b);
    writer.writeString("NETSCAPE2.0");
    writer.writeByte(0x03);
    writer.writeByte(0x01);
    writer.writeUint16(0);
    writer.writeByte(0);
  }

  const transparentIndex = 0;
  let finished = false;

  return {
    addFrame(frame) {
      if (finished) {
        throw new Error("Cannot add a frame after finishing the GIF");
      }
      const indices = new Uint8Array(width * height);
      for (let pixel = 0, i = 0; i < indices.length; i++, pixel += 4) {
        if (transparent && frame[pixel + 3] < 128) {
          indices[i] = transparentIndex;
          continue;
        }
        const r = frame[pixel] >> 3;
        const g = frame[pixel + 1] >> 3;
        const b = frame[pixel + 2] >> 3;
        indices[i] = lookup[(r << 10) | (g << 5) | b];
      }

      // graphic control extension
      writer.writeByte(0x21);
      writer.writeByte(0xf9);
      writer.writeByte(0x04);
      // disposal = 2 (restore to background) when using transparency so frames
      // don't smear into each other; otherwise leave the previous frame
      writer.writeByte(transparent ? 0x0d : 0x04);
      writer.writeUint16(Math.max(2, Math.round(delay)));
      writer.writeByte(transparentIndex);
      writer.writeByte(0);

      // image descriptor
      writer.writeByte(0x2c);
      writer.writeUint16(0);
      writer.writeUint16(0);
      writer.writeUint16(width);
      writer.writeUint16(height);
      writer.writeByte(0);

      // image data
      const compressed = lzwEncode(indices, 8);
      writer.writeByte(8);
      for (let offset = 0; offset < compressed.length; offset += 255) {
        const chunk = compressed.subarray(
          offset,
          Math.min(offset + 255, compressed.length),
        );
        writer.writeByte(chunk.length);
        writer.writeBytes(chunk);
      }
      writer.writeByte(0);
    },
    finish() {
      if (!finished) {
        writer.writeByte(0x3b);
        finished = true;
      }
      return writer.finish();
    },
  };
};

export const encodeGif = (options: EncodeGifOptions): Uint8Array => {
  const writer = createGifWriter({
    ...options,
    paletteFrames: options.frames,
  });
  for (const frame of options.frames) {
    writer.addFrame(frame);
  }
  return writer.finish();
};
