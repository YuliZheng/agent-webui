const VERTICAL_ARROW_OWNER_SELECTOR = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"])',
  "textarea",
  "select",
  "audio",
  "video",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="application"]',
  '[role="combobox"]',
  '[role="grid"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="radiogroup"]',
  '[role="scrollbar"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[data-session-arrow-nav="preserve"]',
].join(",");

const SESSION_NAV_BLOCKING_SURFACE_SELECTOR = [
  ".cw-modal-overlay",
  ".cw-local-file-viewer",
  '[aria-modal="true"]',
  '[role="dialog"]',
].join(",");

// Most of the page should keep ArrowUp/ArrowDown available for conversation
// switching. Preserve the keys only where vertical arrows already have a
// familiar editing, selection, media, or composite-widget meaning.
export function shouldPreserveSessionArrowKey(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function"
    && element.closest(VERTICAL_ARROW_OWNER_SELECTOR) !== null;
}

// Never change the conversation behind a blocking surface, even if that
// surface temporarily loses focus and the key event targets document.body.
export function hasOpenSessionNavBlockingSurface(root: ParentNode = document): boolean {
  return root.querySelector(SESSION_NAV_BLOCKING_SURFACE_SELECTOR) !== null;
}
