import sharp from "sharp";
import crypto from "node:crypto";
import FileType from "file-type";
import { ALLOWED_IMAGE_MIME_TYPES, type AllowedImageMimeType } from "@luvora/shared";
import { config } from "../config";

/**
 * Server-side image inspection, validation, normalization, and thumbnailing.
 *
 * Trust model: the detected MIME, dimensions, and normalized bytes all come
 * from inspecting the actual file content here — never from client-declared
 * values. We also guard against decompression/image bombs via a pixel-count
 * limit and sharp's input constraints.
 */

/** sharp input guard: cap total decoded pixels to defuse decompression bombs.
 *  Configurable via MEDIA_MAX_PIXELS (config.media.maxPixels). sharp refuses to
 *  decode inputs whose pixel count exceeds this, so a crafted tiny-but-huge
 *  image is rejected before it can allocate memory. */
function pixelLimit(): number {
  return config.media.maxPixels;
}

export interface InspectedImage {
  detectedMime: AllowedImageMimeType;
  width: number;
  height: number;
  sha256: string;
}

export interface ProcessedImage {
  normalized: Buffer;
  thumbnail: Buffer;
  detectedMime: AllowedImageMimeType;
  width: number;
  height: number;
  sha256: string;
}

/** Map a sharp format string to an allowed output MIME. */
function formatToMime(format: string | undefined): AllowedImageMimeType | null {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Detect the true content type via magic bytes (file-type) AND sharp metadata,
 * requiring both to agree on an allowed image format. Returns the detected MIME
 * or null if the content is not an allowed, decodable image.
 */
async function detectImageMime(data: Buffer): Promise<AllowedImageMimeType | null> {
  // 1) Magic-byte sniff (independent of any header/extension).
  const sniff = await FileType.fromBuffer(data);
  const sniffMime = sniff?.mime;
  if (!sniffMime || !ALLOWED_IMAGE_MIME_TYPES.includes(sniffMime as AllowedImageMimeType)) {
    return null;
  }
  // 2) sharp must independently decode it to the same family.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(data, { limitInputPixels: pixelLimit(), failOn: "error" }).metadata();
  } catch {
    return null;
  }
  const sharpMime = formatToMime(meta.format);
  if (!sharpMime) return null;
  // Both detectors must agree (defeats polyglots that sniff as one type but
  // decode as another).
  if (sharpMime !== sniffMime) return null;
  return sharpMime;
}

/** Inspect raw bytes: confirm it is an allowed image, extract dimensions, hash. */
export async function inspectImage(data: Buffer): Promise<InspectedImage | null> {
  const detectedMime = await detectImageMime(data);
  if (!detectedMime) return null;

  let meta: sharp.Metadata;
  try {
    meta = await sharp(data, { limitInputPixels: pixelLimit(), failOn: "error" }).metadata();
  } catch {
    return null;
  }
  if (!meta.width || !meta.height) return null;

  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  return { detectedMime, width: meta.width, height: meta.height, sha256 };
}

/**
 * Produce a privacy-safe normalized image and a thumbnail.
 *
 * Normalization:
 *  - Re-encodes via sharp, which DROPS all EXIF/GPS/XMP/ICC metadata by default
 *    (we never pass `.withMetadata()`), auto-orients first so stripping EXIF
 *    orientation doesn't rotate the image, and bounds dimensions.
 *  - Output format mirrors the detected input family (jpeg/png/webp).
 *
 * Thumbnail: longest edge = `thumbnailSize`, same privacy guarantees.
 */
export async function processImage(input: {
  data: Buffer;
  maxWidth: number;
  maxHeight: number;
  thumbnailSize: number;
}): Promise<ProcessedImage | null> {
  const inspected = await inspectImage(input.data);
  if (!inspected) return null;

  const base = () =>
    sharp(input.data, { limitInputPixels: pixelLimit(), failOn: "error" })
      .rotate() // auto-orient using EXIF, THEN we drop metadata on encode
      .resize({
        width: input.maxWidth,
        height: input.maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      });

  const encode = (pipeline: sharp.Sharp): sharp.Sharp => {
    switch (inspected.detectedMime) {
      case "image/jpeg":
        return pipeline.jpeg({ quality: 85 });
      case "image/png":
        return pipeline.png({ compressionLevel: 9 });
      case "image/webp":
        return pipeline.webp({ quality: 85 });
    }
  };

  let normalized: Buffer;
  let thumbnail: Buffer;
  try {
    normalized = await encode(base()).toBuffer();
    thumbnail = await encode(
      sharp(input.data, { limitInputPixels: pixelLimit(), failOn: "error" })
        .rotate()
        .resize({
          width: input.thumbnailSize,
          height: input.thumbnailSize,
          fit: "inside",
          withoutEnlargement: true,
        }),
    ).toBuffer();
  } catch {
    return null;
  }

  // Recompute dimensions from the normalized output (post-resize/orient).
  const normMeta = await sharp(normalized).metadata();

  return {
    normalized,
    thumbnail,
    detectedMime: inspected.detectedMime,
    width: normMeta.width ?? inspected.width,
    height: normMeta.height ?? inspected.height,
    sha256: inspected.sha256, // hash of the ORIGINAL uploaded bytes
  };
}

export interface ProbedDimensions {
  width: number;
  height: number;
  pixels: number;
}

/**
 * Probe only the declared dimensions from an image header WITHOUT fully
 * decoding it (sharp reads metadata lazily). Used to reject oversized images
 * with a precise error BEFORE the full-decode pixel guard kicks in. We still
 * pass a hard ceiling well above the policy limit so a maliciously huge header
 * can't itself cause unbounded work. Returns null if dimensions are unreadable.
 */
export async function probeDimensions(data: Buffer): Promise<ProbedDimensions | null> {
  try {
    // A generous absolute ceiling (10x the policy cap) just to read the header;
    // the real policy decision is made by the caller against config.
    const absoluteCeiling = Math.min(config.media.maxPixels * 10, Number.MAX_SAFE_INTEGER);
    const meta = await sharp(data, { limitInputPixels: absoluteCeiling }).metadata();
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height, pixels: meta.width * meta.height };
  } catch {
    return null;
  }
}

/** Read EXIF presence from a buffer (used by privacy tests to assert the
 *  normalized output no longer carries metadata). */
export async function hasExif(data: Buffer): Promise<boolean> {
  const meta = await sharp(data).metadata();
  // sharp exposes `exif` as a Buffer when present.
  return Boolean(meta.exif && meta.exif.length > 0);
}
