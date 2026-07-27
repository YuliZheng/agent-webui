// Backend's claude-spawn.ts appends attachments (images, PDFs) as a trailer
// to the outgoing prompt:
//
//   ${userText}\n\nAttached files (read with the Read tool to view):
//   - /path/to/.claude-webui/images/<sid>/<file>.png
//   - /path/to/.claude-webui/images/<sid>/<file>.pdf
//
// The frontend mirrors that as the on-disk message text — claude needs the
// paths so it can Read them, but the user shouldn't see the raw paths in
// the rendered chat. Pull the attachments out and return the user-visible
// text with the trailer stripped. Images become inline tiles; PDFs become
// file chips (no preview).

const TRAILER_HEADER = "Attached files (read with the Read tool to view):";
// Pre-PDF wording — still present in historical session jsonls.
const LEGACY_TRAILER_HEADER = "Attached image files (read with the Read tool to view):";
// Matches `.claude-webui/images/<sid>/<filename>` anywhere in a path. Accepts
// either separator: the backend builds the path with node:path `join`, which
// emits backslashes on Windows — a forward-slash-only pattern silently failed
// to match there, so the image bubble never rendered even though the file was
// attached and the model could read it.
const ATTACHMENT_PATH_RE = /[/\\]\.claude-webui[/\\]images[/\\]([A-Za-z0-9_-]+)[/\\]([A-Za-z0-9._-]+)/g;

export interface ExtractedImage { url: string; sid: string; filename: string }
export interface ExtractedPdf { sid: string; filename: string }

export interface ExtractedPrompt {
  text: string;
  images: ExtractedImage[];
  pdfs: ExtractedPdf[];
}

export function extractAttachedImages(raw: string): ExtractedPrompt {
  if (!raw) return { text: "", images: [], pdfs: [] };
  let idx = raw.lastIndexOf(TRAILER_HEADER);
  if (idx < 0) idx = raw.lastIndexOf(LEGACY_TRAILER_HEADER);
  // No trailer at all → text is unchanged.
  if (idx < 0) return { text: raw, images: [], pdfs: [] };
  // Trim two newlines before the trailer if present (matches the join in
  // claude-spawn's decorateWithImages — `\n\nAttached…`).
  let cutEnd = idx;
  if (cutEnd >= 2 && raw[cutEnd - 1] === "\n" && raw[cutEnd - 2] === "\n") cutEnd -= 2;
  else if (cutEnd >= 1 && raw[cutEnd - 1] === "\n") cutEnd -= 1;
  const head = raw.slice(0, cutEnd);
  const trailer = raw.slice(idx);
  const images: ExtractedImage[] = [];
  const pdfs: ExtractedPdf[] = [];
  const seen = new Set<string>();
  for (const m of trailer.matchAll(ATTACHMENT_PATH_RE)) {
    const sid = m[1]!;
    const filename = m[2]!;
    const key = `${sid}/${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (filename.toLowerCase().endsWith(".pdf")) pdfs.push({ sid, filename });
    else images.push({ sid, filename, url: `/api/images/${sid}/${filename}` });
  }
  return { text: head, images, pdfs };
}
