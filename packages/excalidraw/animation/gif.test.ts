import { describe, expect, it } from "vitest";

import { encodeGif } from "./gif";

type DecodedGif = {
  width: number;
  height: number;
  frames: number[][];
};

/** A tiny GIF reader for verifying the encoder (no local color tables). */
const decodeGif = (bytes: Uint8Array): DecodedGif => {
  let offset = 0;
  const readByte = () => bytes[offset++];
  const readUint16 = () => {
    const value = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
    return value;
  };
  const readString = (length: number) => {
    let value = "";
    for (let i = 0; i < length; i++) {
      value += String.fromCharCode(readByte());
    }
    return value;
  };
  const skipSubBlocks = () => {
    while (true) {
      const length = readByte();
      if (!length) {
        return;
      }
      offset += length;
    }
  };
  const readSubBlocks = () => {
    const chunks: number[] = [];
    while (true) {
      const length = readByte();
      if (!length) {
        return chunks;
      }
      for (let i = 0; i < length; i++) {
        chunks.push(readByte());
      }
    }
  };

  expect(readString(6)).toBe("GIF89a");
  const width = readUint16();
  const height = readUint16();
  const packed = readByte();
  readByte();
  readByte();
  const tableSize = 2 ** ((packed & 0x07) + 1);
  offset += tableSize * 3;

  const frames: number[][] = [];
  let minCodeSize = 8;

  while (offset < bytes.length) {
    const marker = readByte();
    if (marker === 0x3b) {
      break;
    }
    if (marker === 0x21) {
      readByte(); // extension label
      skipSubBlocks();
      continue;
    }
    if (marker !== 0x2c) {
      throw new Error(`Unexpected GIF marker ${marker}`);
    }

    offset += 4; // left / top
    readUint16(); // width
    readUint16(); // height
    const imagePacked = readByte();
    if (imagePacked & 0x80) {
      offset += 2 ** ((imagePacked & 0x07) + 1) * 3;
    }

    minCodeSize = readByte();
    const compressed = readSubBlocks();
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;
    let dictionary: number[][] = Array.from(
      { length: clearCode },
      (_, index) => [index],
    );
    let bitBuffer = 0;
    let bitCount = 0;
    let byteIndex = 0;
    let previous: number[] | null = null;
    const pixels: number[] = [];

    while (byteIndex <= compressed.length) {
      while (bitCount < codeSize) {
        if (byteIndex >= compressed.length) {
          throw new Error("Unexpected end of LZW data");
        }
        bitBuffer |= compressed[byteIndex++] << bitCount;
        bitCount += 8;
      }
      const code = bitBuffer & ((1 << codeSize) - 1);
      bitBuffer >>>= codeSize;
      bitCount -= codeSize;

      if (code === clearCode) {
        dictionary = Array.from({ length: clearCode }, (_, index) => [index]);
        codeSize = minCodeSize + 1;
        nextCode = endCode + 1;
        previous = null;
        continue;
      }
      if (code === endCode) {
        break;
      }

      let entry: number[];
      if (code < dictionary.length) {
        entry = dictionary[code];
      } else if (code === nextCode && previous) {
        entry = [...previous, previous[0]];
      } else {
        throw new Error(`Invalid LZW code ${code}`);
      }

      pixels.push(...entry);
      if (previous) {
        dictionary[nextCode++] = [...previous, entry[0]];
        if (nextCode === 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      }
      previous = entry;
    }

    frames.push(pixels);
  }

  return { width, height, frames };
};

const rgba = (pixels: [number, number, number, number][]) =>
  new Uint8ClampedArray(pixels.flat());

describe("encodeGif", () => {
  it("encodes frames with a global palette and correct LZW data", () => {
    const red: [number, number, number, number] = [255, 0, 0, 255];
    const green: [number, number, number, number] = [0, 255, 0, 255];
    const blue: [number, number, number, number] = [0, 0, 255, 255];
    const white: [number, number, number, number] = [255, 255, 255, 255];

    const gif = encodeGif({
      width: 2,
      height: 2,
      frames: [rgba([red, green, blue, white])],
      delay: 5,
    });
    const decoded = decodeGif(gif);

    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0]).toEqual([0, 1, 2, 3]);
  });

  it("encodes multiple frames and transparency", () => {
    const red: [number, number, number, number] = [255, 0, 0, 255];
    const transparent: [number, number, number, number] = [0, 0, 0, 0];

    const gif = encodeGif({
      width: 2,
      height: 1,
      frames: [rgba([red, transparent]), rgba([transparent, red])],
      delay: 5,
      transparent: true,
    });
    const decoded = decodeGif(gif);

    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0]).toEqual([1, 0]);
    expect(decoded.frames[1]).toEqual([0, 1]);
  });

  it("handles images larger than one LZW dictionary", () => {
    const pixels: [number, number, number, number][] = [];
    for (let i = 0; i < 30_000; i++) {
      pixels.push([(i * 37) % 256, (i * 73) % 256, (i * 113) % 256, 255]);
    }
    const gif = encodeGif({
      width: 300,
      height: 100,
      frames: [rgba(pixels)],
      delay: 5,
    });
    const decoded = decodeGif(gif);

    expect(decoded.frames[0]).toHaveLength(30_000);
  });
});
