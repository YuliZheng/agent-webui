const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function leafName(value: string): string {
  return value.trim().split(/[\\/]/).pop()?.trim() ?? "";
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
}

function extensionFromUrl(url: string): string {
  const dataType = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(url)?.[1]?.toLowerCase();
  if (dataType) {
    if (dataType === "jpeg") return "jpg";
    if (dataType === "svg+xml") return "svg";
    if (/^(png|gif|webp|avif|bmp)$/.test(dataType)) return dataType;
  }

  try {
    const parsed = new URL(url, "http://agent-webui.local");
    for (const candidate of [parsed.searchParams.get("path") ?? "", parsed.pathname]) {
      const match = IMAGE_EXTENSION.exec(leafName(candidate));
      if (match) return match[1]!.toLowerCase().replace("jpeg", "jpg");
    }
  } catch { /* fall through to the conservative default */ }
  return "png";
}

export function imageDownloadName(alt: string, url: string): string {
  const altLeaf = safeName(leafName(alt));
  if (altLeaf && altLeaf !== "[image]") {
    return IMAGE_EXTENSION.test(altLeaf) ? altLeaf : `${altLeaf}.${extensionFromUrl(url)}`;
  }

  try {
    const parsed = new URL(url, "http://agent-webui.local");
    const pathLeaf = safeName(leafName(parsed.searchParams.get("path") ?? ""));
    if (pathLeaf && IMAGE_EXTENSION.test(pathLeaf)) return pathLeaf;
    const urlLeaf = safeName(leafName(parsed.pathname));
    if (urlLeaf && IMAGE_EXTENSION.test(urlLeaf)) return urlLeaf;
  } catch { /* use a stable generic name */ }

  return `image.${extensionFromUrl(url)}`;
}
