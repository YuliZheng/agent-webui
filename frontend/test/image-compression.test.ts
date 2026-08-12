import { describe, expect, it } from "vitest";
import {
  PROMPT_PHOTO_LONG_EDGE,
  jpegAttachmentName,
  promptImageDimensions,
} from "../src/util/image-compression.js";

describe("prompt image compression", () => {
  it("uses an aggressive 1920px long-edge ceiling without upscaling", () => {
    expect(PROMPT_PHOTO_LONG_EDGE).toBe(1920);
    expect(promptImageDimensions(4032, 3024)).toEqual({ width: 1920, height: 1440 });
    expect(promptImageDimensions(1000, 750)).toEqual({ width: 1000, height: 750 });
  });

  it("renames converted HEIC and JPEG photos consistently", () => {
    expect(jpegAttachmentName("IMG_1234.HEIC")).toBe("IMG_1234.jpg");
    expect(jpegAttachmentName("photo.jpeg")).toBe("photo.jpg");
    expect(jpegAttachmentName("camera-roll")).toBe("camera-roll.jpg");
  });
});
