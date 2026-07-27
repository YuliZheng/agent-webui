// Copy text to the clipboard with a fallback for non-secure origins.
// `navigator.clipboard` is only defined on secure contexts (HTTPS or
// localhost). Over plain HTTP (e.g. http://host:8787 on the LAN) it is
// undefined, so we fall back to a hidden <textarea> + execCommand("copy").
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("Clipboard unavailable (insecure context)");
  } finally {
    document.body.removeChild(ta);
  }
}
