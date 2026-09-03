export interface ToolResultImage {
  url: string;
}

function renderableImageUrl(url: string): boolean {
  return /^data:image\//i.test(url)
    || /^https?:\/\//i.test(url)
    || /^\/api\/sessions\/[^/?#]+\/(?:input-image|transcript-image)\/\d+\/\d+(?:[?#]|$)/i.test(url);
}

function imageUrl(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, any>;

  if (block.type === "image" && block.source?.type === "base64") {
    const mime = block.source.media_type ?? block.source.mediaType;
    if (typeof mime === "string" && mime.startsWith("image/") && typeof block.source.data === "string") {
      return `data:${mime};base64,${block.source.data}`;
    }
  }
  // MCP/shared ContentBlock shape returned by Codex custom tools.
  if (block.type === "image" && typeof block.data === "string") {
    const mime = block.mimeType ?? block.mime_type;
    if (typeof mime === "string" && mime.startsWith("image/")) return `data:${mime};base64,${block.data}`;
  }
  if (block.type === "image" && block.source?.type === "url" && typeof block.source.url === "string") {
    return block.source.url;
  }
  if (block.type === "input_image" || block.type === "output_image" || block.type === "image_url") {
    const candidate = block.image_url ?? block.imageUrl ?? block.url;
    const url = typeof candidate === "string" ? candidate : candidate?.url;
    if (typeof url === "string" && renderableImageUrl(url)) return url;
  }
  return null;
}

function contentArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) return content;
  }
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try { return contentArray(JSON.parse(value)); } catch { /* ordinary text output */ }
  }
  return [];
}

export function extractToolResultImages(value: unknown): ToolResultImage[] {
  const out: ToolResultImage[] = [];
  const seen = new Set<string>();
  for (const block of contentArray(value)) {
    const url = imageUrl(block);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url });
    }
  }
  return out;
}

export function extractToolRunImages(values: readonly unknown[]): ToolResultImage[] {
  const out: ToolResultImage[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const image of extractToolResultImages(value)) {
      if (seen.has(image.url)) continue;
      seen.add(image.url);
      out.push(image);
    }
  }
  return out;
}

export function toolResultImageUrl(value: unknown): string | null {
  return imageUrl(value);
}
