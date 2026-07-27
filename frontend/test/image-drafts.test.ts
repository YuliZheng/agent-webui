import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useImageDraftsStore } from "../src/stores/image-drafts.js";

function image(name: string) {
  return {
    mime: "image/png",
    base64: `${name}-base64`,
    dataUrl: `data:image/png;base64,${name}`,
    bytes: 10,
    name,
  };
}

describe("useImageDraftsStore dispatch recovery", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("takes only the dispatched images and restores them before newer ones", () => {
    const drafts = useImageDraftsStore();
    drafts.add("s", image("first"));
    drafts.add("s", image("second"));
    const [first, second] = drafts.list("s");

    const removed = drafts.take("s", [first!.id]);
    expect(removed.map((item) => item.name)).toEqual(["first"]);
    expect(drafts.list("s").map((item) => item.name)).toEqual(["second"]);

    drafts.add("s", image("newer"));
    drafts.restore("s", removed);
    expect(drafts.list("s").map((item) => item.name)).toEqual(["first", "second", "newer"]);

    drafts.restore("s", [first!, second!]);
    expect(drafts.list("s").map((item) => item.name)).toEqual(["first", "second", "newer"]);
  });

  it("moves unsent attachments to a promoted session id", () => {
    const drafts = useImageDraftsStore();
    drafts.add("draft:1", image("waiting"));
    drafts.add("real:1", image("existing"));

    drafts.moveSession("draft:1", "real:1");
    expect(drafts.list("draft:1")).toEqual([]);
    expect(drafts.list("real:1").map((item) => item.name)).toEqual(["waiting", "existing"]);
  });
});
