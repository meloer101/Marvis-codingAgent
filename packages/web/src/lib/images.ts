/**
 * Images put in a message from the composer (pasted, dropped or picked):
 * read as base64, and — when too big for a model to take whole, or in a format
 * it doesn't take — redrawn smaller as PNG or JPEG first. Kept in the draft
 * only until it is sent: never in storage.
 */

import type { ImageInput } from '@harness-code/core';

/** What the server takes in one message (`session.send {images}`). */
export const MAX_IMAGES = 8;
const MAX_BYTES = 5 * 1024 * 1024;
/** Models downscale anyway (Claude to ~1568 px on the long edge); past this the bytes buy nothing. */
export const MAX_IMAGE_EDGE = 2048;
const TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Whether a dropped, pasted or picked file goes in as an image (else as a file, uploaded). */
export function isImageFile(file: Blob): boolean {
  // An SVG is text a model reads better than a picture of it.
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

/** An image as an `<img src>`. */
export function imageSrc(image: ImageInput): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** A file's bytes as base64 (no `data:` prefix). */
export function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(blob);
  });
}

/** A file from the clipboard, a drop or the picker, as an image for the message. */
export async function readImage(file: Blob): Promise<ImageInput> {
  const takenAsIs = TYPES.includes(file.type) && file.size <= MAX_BYTES;
  // Without a decoder (tests, old browsers) an image that fits goes as it is.
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    if (!takenAsIs) throw new Error('This image is too big or in a format the model can’t take.');
    return { mediaType: file.type as ImageInput['mediaType'], data: await readBase64(file) };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This file can’t be read as an image.');
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (takenAsIs && scale === 1) {
    bitmap.close();
    return { mediaType: file.type as ImageInput['mediaType'], data: await readBase64(file) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
  // A PNG stays one (screenshots keep their sharp text) unless it is still too big.
  let type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  let blob = await encode(type);
  if (blob && blob.size > MAX_BYTES && type === 'image/png') {
    type = 'image/jpeg';
    blob = await encode(type);
  }
  if (!blob || blob.size > MAX_BYTES) throw new Error('This image is too big to send.');
  return { mediaType: type as ImageInput['mediaType'], data: await readBase64(blob) };
}
