import { beforeEach, describe, expect, it } from "vitest";
import {
  hasOpenSessionNavBlockingSurface,
  shouldPreserveSessionArrowKey,
} from "../src/util/session-keyboard-nav.js";

describe("global conversation arrow navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves arrows global on ordinary page content and buttons", () => {
    document.body.innerHTML = '<main><div id="surface"><button id="action">Action</button></div></main>';

    expect(shouldPreserveSessionArrowKey(document.body)).toBe(false);
    expect(shouldPreserveSessionArrowKey(document.querySelector("#surface"))).toBe(false);
    expect(shouldPreserveSessionArrowKey(document.querySelector("#action"))).toBe(false);
  });

  it("preserves arrows for editing and arrow-driven controls", () => {
    document.body.innerHTML = `
      <input id="search" />
      <textarea id="composer"></textarea>
      <div contenteditable="true"><span id="editable-child">Draft</span></div>
      <div role="menu"><button id="menu-item" role="menuitem">Open</button></div>
      <div role="slider" id="slider"></div>
    `;

    for (const selector of ["#search", "#composer", "#editable-child", "#menu-item", "#slider"]) {
      expect(shouldPreserveSessionArrowKey(document.querySelector(selector))).toBe(true);
    }
  });

  it("blocks background switching while an overlay owns the page", () => {
    expect(hasOpenSessionNavBlockingSurface()).toBe(false);
    document.body.innerHTML = '<div class="cw-modal-overlay"><section>Settings</section></div>';
    expect(hasOpenSessionNavBlockingSurface()).toBe(true);
    document.body.innerHTML = '<div role="dialog">Status</div>';
    expect(hasOpenSessionNavBlockingSurface()).toBe(true);
  });
});
