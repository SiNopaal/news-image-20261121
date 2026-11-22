import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { sourceMissing: 2, sizeExceeded: 3, invalidFormat: 4, unsupportedDimensions: 5, incompletePng: 6, deliveryFailure: 7 } as const;

class DeliveryError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'DeliveryError';
    this.exitCode = exitCode;
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectPng(png: Buffer): { width: number; height: number; bitDepth: number; colourType: number; complete: boolean } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 8 || !png.subarray(0, 8).equals(signature)) throw new DeliveryError('Source is not a PNG', EXIT.invalidFormat);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let channels = 0;
  let sawHeader = false;
  let sawData = false;
  let dataEnded = false;
  let sawPalette = false;
  const dataParts: Buffer[] = [];
  let offset = 8;

  const incomplete = () => ({ width, height, bitDepth, colourType, complete: false });
  const validateImageData = () => {
    if (!sawData) throw new DeliveryError('PNG has no image data', EXIT.invalidFormat);
    if (colourType === 3 && !sawPalette) throw new DeliveryError('Indexed PNG has no palette', EXIT.invalidFormat);

    const bitsPerPixel = channels * bitDepth;
    const passes = [[0, 0, 1, 1]];
    if (png[28] === 1) {
      passes.splice(0, 1,
        [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
      );
    }
    let expected = 0;
    const rows: number[] = [];
    for (const [xStart, yStart, xStep, yStep] of passes) {
      const passWidth = width <= xStart ? 0 : Math.ceil((width - xStart) / xStep);
      const passHeight = height <= yStart ? 0 : Math.ceil((height - yStart) / yStep);
      if (passWidth && passHeight) {
        const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);
        for (let row = 0; row < passHeight; row++) rows.push(rowBytes);
        expected += passHeight * (rowBytes + 1);
      }
    }

    const compressed = Buffer.concat(dataParts);
    try {
      const { buffer: decoded, engine } = inflateSync(compressed, { info: true, maxOutputLength: expected });
      if (engine.bytesWritten !== compressed.length || decoded.length !== expected) {
        throw new Error('PNG image data has an incomplete or incorrect length');
      }
      let cursor = 0;
      for (const rowBytes of rows) {
        if (decoded[cursor] > 4) throw new Error('PNG image data has an invalid row filter');
        cursor += rowBytes + 1;
      }
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(`PNG image data is invalid: ${String(error)}`, EXIT.invalidFormat);
    }
  };

  while (offset < png.length) {
    if (png.length - offset < 12) return incomplete();
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return incomplete();
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const type = png.toString('ascii', offset + 4, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) {
      throw new DeliveryError('PNG has an invalid chunk type', EXIT.invalidFormat);
    }
    if (crc32(png.subarray(offset + 4, crcOffset)) !== png.readUInt32BE(crcOffset)) {
      throw new DeliveryError(`PNG ${type} chunk has a bad checksum`, EXIT.invalidFormat);
    }
    if (!sawHeader && (type !== 'IHDR' || length !== 13)) {
      throw new DeliveryError('PNG must start with a valid IHDR chunk', EXIT.invalidFormat);
    }
    if (sawHeader && type === 'IHDR') throw new DeliveryError('PNG has more than one IHDR chunk', EXIT.invalidFormat);
    if (type[0] === type[0].toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      throw new DeliveryError(`PNG has an unknown critical chunk: ${type}`, EXIT.invalidFormat);
    }

    if (type === 'IHDR') {
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colourType = png[dataStart + 9];
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType] ?? 0;
      if (!width || !height || !channels || !validDepths[colourType].includes(bitDepth) || png[dataStart + 10] !== 0 || png[dataStart + 11] !== 0 || png[dataStart + 12] > 1) {
        throw new DeliveryError('PNG has an invalid IHDR', EXIT.invalidFormat);
      }
      if (width > 1024 || height > 1024) {
        throw new DeliveryError(`PNG dimensions exceed 1024x1024: ${width}x${height}`, EXIT.unsupportedDimensions);
      }
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || colourType === 0 || colourType === 4 || !length || length > 768 || length % 3 !== 0 || (colourType === 3 && length / 3 > 2 ** bitDepth)) {
        throw new DeliveryError('PNG has an invalid palette chunk', EXIT.invalidFormat);
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (colourType === 3 && !sawPalette)) throw new DeliveryError('PNG has misplaced image data', EXIT.invalidFormat);
      dataParts.push(png.subarray(dataStart, crcOffset));
      sawData = true;
    } else {
      if (sawData) dataEnded = true;
      if (type === 'IEND') {
        if (length !== 0) throw new DeliveryError('PNG has an invalid IEND chunk', EXIT.invalidFormat);
        validateImageData();
        return { width, height, bitDepth, colourType, complete: crcOffset + 4 === png.length };
      }
    }
    offset = crcOffset + 4;
  }
  return incomplete();
}

async function main(): Promise<void> {
  const source = fileURLToPath(new URL('./entry.png', import.meta.url));
  let png: Buffer;
  try {
    png = await readFile(source);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new DeliveryError('Source image is missing: entry.png', EXIT.sourceMissing);
    }
    throw new DeliveryError(`Could not read source image: ${String(error)}`, EXIT.deliveryFailure);
  }

  if (png.length > 1_048_576) throw new DeliveryError('Image exceeds the 1 MiB size limit', EXIT.sizeExceeded);
  const image = inspectPng(png);
  if (!image.width || !image.height) throw new DeliveryError('PNG has invalid zero dimensions', EXIT.invalidFormat);
  if (image.width > 1024 || image.height > 1024) {
    throw new DeliveryError(`PNG dimensions exceed 1024x1024: ${image.width}x${image.height}`, EXIT.unsupportedDimensions);
  }
  if (!image.complete) throw new DeliveryError('PNG is incomplete or does not end with IEND', EXIT.incompletePng);

  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'entry.png'), png);
  } catch (error) {
    throw new DeliveryError(`Could not deliver image: ${String(error)}`, EXIT.deliveryFailure);
  }
  console.log(`Wrote ${png.length} bytes; PNG ${image.width}x${image.height}, ${image.bitDepth}-bit colour type ${image.colourType}, complete ${image.complete}; sha256 ${createHash('sha256').update(png).digest('hex')}`);
}

main().catch((error: unknown) => {
  if (error instanceof DeliveryError) {
    console.error(`${error.message} (exit ${error.exitCode})`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`Unexpected delivery failure: ${String(error)} (exit ${EXIT.deliveryFailure})`);
    process.exitCode = EXIT.deliveryFailure;
  }
});
