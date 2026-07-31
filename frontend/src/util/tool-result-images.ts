export interface ToolResultImage {
  url: string;
}

export function extractToolResultImages(value: unknown): ToolResultImage[] {
  if (!Array.isArray(value)) return [];
  const out: ToolResultImage[] = [];
  for (const block of value as any[]) {
    const source = block?.type === "image" ? block.source : null;
    if (
      source?.type === "base64"
      && typeof source.media_type === "string"
      && typeof source.data === "string"
    ) {
      out.push({ url: `data:${source.media_type};base64,${source.data}` });
    }
  }
  return out;
}
