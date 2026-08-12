export const PROMPT_PHOTO_LONG_EDGE = 1920;
export const PROMPT_PHOTO_TARGET_BYTES = Math.round(1.5 * 1024 * 1024);
export const PROMPT_PHOTO_INITIAL_QUALITY = 0.78;

const SOURCE_IMAGE_MAX_BYTES = 60 * 1024 * 1024;
const IMAGE_LOAD_TIMEOUT_MS = 30_000;
const COMPRESSIBLE_PHOTO = /^image\/(?:jpe?g|heic|heif)$/i;

export interface PreparedPromptAttachment {
  blob: Blob;
  name?: string | undefined;
  originalBytes: number;
  compressed: boolean;
}

export function promptImageDimensions(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0 || longest <= PROMPT_PHOTO_LONG_EDGE) {
    return { width, height };
  }
  const scale = PROMPT_PHOTO_LONG_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function jpegAttachmentName(name?: string): string | undefined {
  if (!name) return name;
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, ".jpg") : `${name}.jpg`;
}

function looksLikeCompressiblePhoto(blob: Blob, name?: string): boolean {
  return COMPRESSIBLE_PHOTO.test(blob.type) || /\.(?:jpe?g|heic|heif)$/i.test(name ?? "");
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      callback();
    };
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Timed out while decoding this photo."))),
      IMAGE_LOAD_TIMEOUT_MS,
    );
    img.onload = () => finish(() => resolve(img));
    img.onerror = () => finish(() => reject(new Error("This photo format could not be decoded by the browser.")));
    img.src = url;
  });
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("The browser could not encode this photo.")),
      "image/jpeg",
      quality,
    );
  });
}

export async function preparePromptAttachment(
  blob: Blob,
  name: string | undefined,
  sendOriginal: boolean,
): Promise<PreparedPromptAttachment> {
  const originalBytes = blob.size;
  if (sendOriginal || !looksLikeCompressiblePhoto(blob, name)) {
    return { blob, name, originalBytes, compressed: false };
  }
  if (blob.size > SOURCE_IMAGE_MAX_BYTES) {
    throw new Error("Photo exceeds the 60 MiB source limit. Resize it before attaching.");
  }

  const image = await loadImage(blob);
  const dimensions = promptImageDimensions(image.naturalWidth, image.naturalHeight);
  // Already-small JPEGs gain little from another lossy encode.
  if (
    /^image\/jpe?g$/i.test(blob.type)
    && blob.size <= PROMPT_PHOTO_TARGET_BYTES
    && dimensions.width === image.naturalWidth
    && dimensions.height === image.naturalHeight
  ) {
    return { blob, name, originalBytes, compressed: false };
  }

  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Image compression is unavailable in this browser.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let encoded = await canvasJpeg(canvas, PROMPT_PHOTO_INITIAL_QUALITY);
  for (const quality of [0.68, 0.58]) {
    if (encoded.size <= PROMPT_PHOTO_TARGET_BYTES) break;
    encoded = await canvasJpeg(canvas, quality);
  }

  // Do not replace a supported original with a larger lossy version. HEIC and
  // HEIF still need the JPEG conversion because the backend cannot accept them.
  if (encoded.size >= blob.size && /^image\/jpe?g$/i.test(blob.type)) {
    return { blob, name, originalBytes, compressed: false };
  }
  return {
    blob: encoded,
    name: jpegAttachmentName(name),
    originalBytes,
    compressed: true,
  };
}
