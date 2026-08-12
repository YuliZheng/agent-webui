import { describe, expect, it } from "vitest";
import {
  sanitizeTranscriptLines,
  sanitizeTranscriptRaw,
  transcriptImagePayload,
} from "../src/services/transcript-images.js";

const PNG = "aGVsbG8=";
const WEBP = "d29ybGQ=";

describe("transcript image wire references", () => {
  it("removes inline image bytes while preserving stable transcript URLs", () => {
    const record = {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: {
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
            { type: "image", mimeType: "image/webp", data: WEBP },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: PNG },
            },
          ],
        },
      },
    };
    const raw = JSON.stringify(record);
    const sanitized = sanitizeTranscriptRaw(raw, "session-id", 27);
    const parsed = JSON.parse(sanitized) as any;
    const content = parsed.payload.output.content;

    expect(sanitized).not.toContain(PNG);
    expect(sanitized).not.toContain(WEBP);
    expect(content[0]).toMatchObject({
      media_type: "image/png",
      __agentWebuiSourceIndex: 27,
      __agentWebuiImageIndex: 0,
    });
    expect(content[0].image_url).toMatch(/^\/api\/sessions\/session-id\/transcript-image\/27\/0\?v=[A-Za-z0-9_-]{16}$/);
    expect(content[1].source).toMatchObject({
      type: "url",
      media_type: "image/webp",
      lineIndex: 27,
      imageIndex: 1,
    });
    expect(content[1].source.url).toMatch(/^\/api\/sessions\/session-id\/transcript-image\/27\/1\?v=[A-Za-z0-9_-]{16}$/);
    expect(content[2].source).toMatchObject({
      type: "url",
      media_type: "image/png",
      lineIndex: 27,
      imageIndex: 2,
    });
    expect(content[2].source.url).toMatch(/^\/api\/sessions\/session-id\/transcript-image\/27\/2\?v=[A-Za-z0-9_-]{16}$/);

    expect(transcriptImagePayload(record, 0)).toEqual({
      type: "image/png",
      data: PNG,
    });
    expect(transcriptImagePayload(record, 1)).toEqual({ type: "image/webp", data: WEBP });
    expect(transcriptImagePayload(record, 2)).toEqual({ type: "image/png", data: PNG });
    expect(transcriptImagePayload(record, 3)).toBeNull();
  });

  it("sanitizes JSON-serialized tool outputs and keeps ordinary lines byte-for-byte", () => {
    const nestedOutput = JSON.stringify({
      content: [{ type: "image", mimeType: "image/png", data: PNG }],
    });
    const raw = JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call_output", output: nestedOutput },
    });
    const sanitized = sanitizeTranscriptRaw(raw, "nested", 9);
    expect(sanitized).not.toContain(PNG);
    expect(sanitized).toContain("/api/sessions/nested/transcript-image/9/0");
    expect(transcriptImagePayload(JSON.parse(raw), 0)).toEqual({ type: "image/png", data: PNG });

    const text = '{"type":"event_msg","payload":{"type":"agent_message","message":"image/png"}}';
    expect(sanitizeTranscriptRaw(text, "nested", 10)).toBe(text);
    expect(sanitizeTranscriptLines("nested", [{ index: 9, raw }])[0]!.raw).toBe(sanitized);
  });
});
