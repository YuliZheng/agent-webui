import { createHash } from "node:crypto";
import type { IndexedRawLine } from "../types.js";

export interface TranscriptImagePayload {
  type: string;
  data: string;
}

const TRANSCRIPT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/\r\n]*={0,2})$/i;
const MAX_NESTED_JSON_DEPTH = 32;

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedImageType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase();
  return TRANSCRIPT_IMAGE_TYPES.has(normalized) ? normalized : null;
}

function dataImage(value: unknown): TranscriptImagePayload | null {
  const raw = stringValue(value);
  const match = raw ? DATA_IMAGE.exec(raw) : null;
  const type = normalizedImageType(match?.[1]);
  return raw && type && match?.[2]
    ? { type, data: match[2].replace(/[\r\n]/g, "") }
    : null;
}

interface InlineImage {
  payload: TranscriptImagePayload;
  replace: (url: string, lineIndex: number, imageIndex: number) => void;
}

function inlineImage(block: Record<string, unknown>): InlineImage | null {
  const blockType = stringValue(block.type);
  const source = recordValue(block.source);
  if (blockType === "image" && source) {
    const mediaType = normalizedImageType(source.media_type ?? source.mediaType);
    const data = stringValue(source.data);
    if (source.type === "base64" && mediaType && data) {
      return {
        payload: { type: mediaType, data: data.replace(/[\r\n]/g, "") },
        replace: (url, lineIndex, imageIndex) => {
          const replacement = { ...source };
          delete replacement.data;
          replacement.type = "url";
          replacement.url = url;
          replacement.media_type = mediaType;
          replacement.lineIndex = lineIndex;
          replacement.imageIndex = imageIndex;
          block.source = replacement;
        },
      };
    }
    const sourceUrl = dataImage(source.url);
    if (source.type === "url" && sourceUrl) {
      return {
        payload: sourceUrl,
        replace: (url, lineIndex, imageIndex) => {
          block.source = {
            ...source,
            type: "url",
            url,
            media_type: sourceUrl.type,
            lineIndex,
            imageIndex,
          };
        },
      };
    }
  }

  if (blockType === "image") {
    const mediaType = normalizedImageType(block.mimeType ?? block.mime_type);
    const data = stringValue(block.data);
    if (mediaType && data) {
      return {
        payload: { type: mediaType, data: data.replace(/[\r\n]/g, "") },
        replace: (url, lineIndex, imageIndex) => {
          delete block.data;
          block.source = {
            type: "url",
            url,
            media_type: mediaType,
            lineIndex,
            imageIndex,
          };
        },
      };
    }
  }

  if (blockType === "input_image" || blockType === "output_image" || blockType === "image_url") {
    for (const field of ["image_url", "imageUrl", "url"] as const) {
      const candidate = block[field];
      const nested = recordValue(candidate);
      const payload = dataImage(nested?.url ?? candidate);
      if (!payload) continue;
      return {
        payload,
        replace: (url, lineIndex, imageIndex) => {
          block[field] = nested ? { ...nested, url } : url;
          block.media_type = payload.type;
          block.__agentWebuiSourceIndex = lineIndex;
          block.__agentWebuiImageIndex = imageIndex;
        },
      };
    }
  }
  return null;
}

interface WalkState {
  mode: "collect" | "sanitize";
  sessionId?: string;
  lineIndex: number;
  payloads: TranscriptImagePayload[];
  replacements: number;
}

function transcriptImageUrl(
  sessionId: string,
  lineIndex: number,
  imageIndex: number,
  payload: TranscriptImagePayload,
): string {
  // Transcript line numbers can be reused after rewind/fork. Version the
  // otherwise-stable URL so immutable browser caches never serve an image
  // that belonged to the previous contents of the same physical line.
  const version = createHash("sha256")
    .update(payload.type)
    .update("\0")
    .update(payload.data)
    .digest("base64url")
    .slice(0, 16);
  return `/api/sessions/${encodeURIComponent(sessionId)}/transcript-image/${lineIndex}/${imageIndex}?v=${version}`;
}

function walk(value: unknown, state: WalkState, depth = 0): void {
  if (depth > MAX_NESTED_JSON_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, state, depth + 1);
    return;
  }
  const record = recordValue(value);
  if (!record) return;

  const image = inlineImage(record);
  if (image) {
    const imageIndex = state.payloads.length;
    state.payloads.push(image.payload);
    if (state.mode === "sanitize" && state.sessionId) {
      image.replace(
        transcriptImageUrl(state.sessionId, state.lineIndex, imageIndex, image.payload),
        state.lineIndex,
        imageIndex,
      );
      state.replacements++;
    }
    return;
  }

  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      const trimmed = child.trimStart();
      if (!child.includes("image/") || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
      try {
        const nested = JSON.parse(child) as unknown;
        const before = state.replacements;
        walk(nested, state, depth + 1);
        if (state.mode === "sanitize" && state.replacements > before) record[key] = JSON.stringify(nested);
      } catch {
        // Ordinary tool text that happens to start with JSON punctuation.
      }
      continue;
    }
    walk(child, state, depth + 1);
  }
}

export function transcriptImagePayload(record: Record<string, unknown>, imageIndex: number): TranscriptImagePayload | null {
  const state: WalkState = {
    mode: "collect",
    lineIndex: -1,
    payloads: [],
    replacements: 0,
  };
  walk(record, state);
  return state.payloads[imageIndex] ?? null;
}

export function sanitizeTranscriptRaw(raw: string, sessionId: string, lineIndex: number): string {
  if (!raw.includes("image/")) return raw;
  let record: unknown;
  try {
    record = JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
  const state: WalkState = {
    mode: "sanitize",
    sessionId,
    lineIndex,
    payloads: [],
    replacements: 0,
  };
  walk(record, state);
  return state.replacements ? JSON.stringify(record) : raw;
}

export function sanitizeTranscriptLines(sessionId: string, lines: IndexedRawLine[]): IndexedRawLine[] {
  return lines.map(line => ({
    ...line,
    raw: sanitizeTranscriptRaw(line.raw, sessionId, line.index),
  }));
}
