import { describe, expect, it, vi } from "vitest";
import { fileStatuses, modelSlugs } from "../../functions/constants";
import { rehostImportImages } from "../../functions/utils/rehost-images";

describe("rehostImportImages", () => {
  it("uploads external product/category image URLs and rewrites Swell file objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
        });
      }),
    );

    let fileIndex = 0;
    const get = vi.fn(async (url: string, query?: any) => {
      if (url === "/imports/import_1") {
        return {
          image_rehost_product_page: 1,
          image_rehost_category_page: 1,
          image_rehost_processed_count: 0,
          image_rehost_error_count: 0,
        };
      }
      if (url === "/imports:files") {
        return {
          results: [
            { slug: modelSlugs.PRODUCTS_VARIANTS, status: fileStatuses.COMPLETED },
            { slug: modelSlugs.CATEGORIES, status: fileStatuses.COMPLETED },
          ],
        };
      }
      if (url.startsWith("/image-cache/")) {
        return null;
      }
      if (url === "/products") {
        expect(query["$app.app_1.import_id"]).toBeUndefined();
        return {
          page_count: 1,
          results: [
            {
              id: "prod_1",
              $app: { app_1: { import_id: "import_1" } },
              images: [{ id: "img_1", caption: "Main", file: { url: "https://source.test/p.jpg" } }],
              options: [
                {
                  id: "opt_1",
                  values: [
                    {
                      id: "value_1",
                      images: [{ id: "img_2", file: { url: "https://source.test/value.jpg" } }],
                    },
                  ],
                },
              ],
            },
            {
              // Not from this import — must be skipped, not rehosted.
              id: "prod_other",
              $app: { app_1: { import_id: "other_import" } },
              images: [{ id: "img_x", file: { url: "https://source.test/other.jpg" } }],
            },
          ],
        };
      }
      if (url === "/products:variants") {
        return {
          results: [
            {
              id: "var_1",
              images: [{ id: "img_3", file: { url: "https://source.test/variant.jpg" } }],
            },
          ],
        };
      }
      if (url === "/categories") {
        expect(query["$app.app_1.import_id"]).toBeUndefined();
        return {
          page_count: 1,
          results: [
            {
              id: "cat_1",
              $app: { app_1: { import_id: "import_1" } },
              images: [{ id: "img_4", file: { url: "https://source.test/category.jpg" } }],
            },
          ],
        };
      }
      throw new Error(`Unexpected get ${url}`);
    });

    const post = vi.fn(async (url: string, body?: any) => {
      expect(url).toBe("/:files");
      expect(body.content_type).toBe("image/jpeg");
      expect(body.filename).toMatch(/\.jpg$/);
      fileIndex += 1;
      return {
        id: `file_${fileIndex}`,
        url: `https://cdn.swell.store/test/file-${fileIndex}.jpg`,
        length: 3,
        md5: `md5_${fileIndex}`,
        content_type: "image/jpeg",
        filename: body.filename,
      };
    });

    const put = vi.fn(async () => ({}));

    const result = await rehostImportImages(
      { get, post, put } as any,
      { importId: "import_1", appId: "app_1", maxImages: 10 },
    );

    expect(result).toEqual({
      processed: 4,
      errors: 0,
      productsCompleted: true,
      categoriesCompleted: true,
    });

    expect(put).toHaveBeenCalledWith(
      "/products/prod_1",
      expect.objectContaining({
        $set: expect.objectContaining({
          images: [
            expect.objectContaining({
              id: "img_1",
              file: expect.objectContaining({
                id: "file_1",
                url: "https://cdn.swell.store/test/file-1.jpg",
                length: 3,
                md5: "md5_1",
                content_type: "image/jpeg",
              }),
            }),
          ],
          options: [
            expect.objectContaining({
              values: [
                expect.objectContaining({
                  image: expect.objectContaining({
                    id: "file_2",
                    url: "https://cdn.swell.store/test/file-2.jpg",
                  }),
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(put).toHaveBeenCalledWith(
      "/products:variants/var_1",
      expect.objectContaining({
        $set: {
          images: [
            expect.objectContaining({
              file: expect.objectContaining({ id: "file_3" }),
            }),
          ],
        },
      }),
    );
    expect(put).toHaveBeenCalledWith(
      "/categories/cat_1",
      expect.objectContaining({
        $set: {
          images: [
            expect.objectContaining({
              file: expect.objectContaining({ id: "file_4" }),
            }),
          ],
        },
      }),
    );
    expect(put).not.toHaveBeenCalledWith("/products/prod_other", expect.anything());
    expect(put).toHaveBeenCalledWith(
      "/imports/import_1",
      expect.objectContaining({
        $set: expect.objectContaining({
          image_rehost_products_completed: true,
          image_rehost_categories_completed: true,
          image_rehost_processed_count: 4,
          image_rehost_error_count: 0,
          date_images_completed: expect.any(String),
        }),
      }),
    );
  });
});
