import { describe, expect, it, vi } from "vitest";
import { loadImage } from "../../functions/utils/image";

describe("loadImage image cache", () => {
  it("reuses a cached Swell file without fetching the source image", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const get = vi.fn(async (url: string) => {
      expect(url).toMatch(/^\/image-cache\/[0-9a-f]{24}$/);
      return {
        file_id: "file_1",
        file_url: "https://cdn.example/file.jpg",
        length: 123,
        md5: "abc",
        content_type: "image/jpeg",
        filename: "file.jpg",
      };
    });
    const post = vi.fn();

    const file = await loadImage({ get, post } as any, "https://source.example/image.jpg");

    expect(file).toEqual({
      id: "file_1",
      url: "https://cdn.example/file.jpg",
      length: 123,
      md5: "abc",
      content_type: "image/jpeg",
      filename: "file.jpg",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
