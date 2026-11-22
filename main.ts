import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { sourceMissing: 2, sizeExceeded: 3, invalidFormat: 4, unsupportedDimensions: 5, deliveryFailure: 6 } as const;

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

function inspectPng(png: Buffer): { width: number; height: number; iend: boolean } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 8 || !png.subarray(0, 8).equals(signature)) throw new DeliveryError('Source is not a PNG', EXIT.invalidFormat);

  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let iend = false;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (crcOffset + 4 > png.length) break;
    const type = png.toString('ascii', offset + 4, dataStart);
    if (crc32(png.subarray(offset + 4, crcOffset)) !== png.readUInt32BE(crcOffset)) {
      throw new DeliveryError(`PNG ${type} chunk has a bad checksum`, EXIT.invalidFormat);
    }
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new DeliveryError('PNG must start with a valid IHDR chunk', EXIT.invalidFormat);
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      sawHeader = true;
    } else if (type === 'IHDR') {
      throw new DeliveryError('PNG has more than one IHDR chunk', EXIT.invalidFormat);
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData) throw new DeliveryError('PNG has an invalid IEND chunk or no image data', EXIT.invalidFormat);
      iend = crcOffset + 4 === png.length;
      break;
    }
    offset = crcOffset + 4;
  }
  return { width, height, iend };
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
  const { width, height, iend } = inspectPng(png);
  if (width === 0 || height === 0) throw new DeliveryError('PNG has invalid zero dimensions', EXIT.invalidFormat);
  if (width > 1024 || height > 1024) throw new DeliveryError(`PNG dimensions exceed 1024x1024: ${width}x${height}`, EXIT.unsupportedDimensions);
  if (!iend) throw new DeliveryError('PNG is incomplete or does not end with IEND', EXIT.invalidFormat);

  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'entry.png'), png);
  } catch (error) {
    throw new DeliveryError(`Could not deliver image: ${String(error)}`, EXIT.deliveryFailure);
  }
  console.log(`Wrote ${png.length} bytes; sha256 ${createHash('sha256').update(png).digest('hex')}`);
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
