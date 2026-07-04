import { describe, expect, it, vi } from "vitest";
import { createProducts } from "../../functions/utils/product";

describe("createProducts workflow image handling", () => {
  it("preserves source image URLs instead of rehosting via blocked workflow file APIs", async () => {
    const post = vi.fn(async (url: string) => {
      if (url === "/:files") {
        throw new Error("workflow file upload should not be called");
      }
      if (url === "/:batch") return {};
      throw new Error(`Unexpected post ${url}`);
    });

    await createProducts(
      {
        isWorkflow: true,
        appValues: (values: object) => ({ $app: { flexiport_client_app: values } }),
        swell: { post },
      } as any,
      {
        importId: "import_1",
        records: [
          {
            slug: "product-1",
            images: [{ caption: "Main", file: { url: "https://cdn.example/product.jpg" } }],
            variants: [
              {
                id: "variant-1",
                images: [{ caption: "Variant", file: { url: "https://cdn.example/variant.jpg" } }],
              },
            ],
            options: [
              {
                id: "option-1",
                values: [
                  {
                    id: "value-1",
                    images: [{ caption: "Value", file: { url: "https://cdn.example/value.jpg" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/:batch",
      expect.arrayContaining([
        expect.objectContaining({
          method: "put",
          url: "/products/product-1",
          data: expect.objectContaining({
            images: [{ caption: "Main", file: { url: "https://cdn.example/product.jpg" } }],
            variants: [
              expect.objectContaining({
                images: [{ caption: "Variant", file: { url: "https://cdn.example/variant.jpg" } }],
              }),
            ],
            options: [
              expect.objectContaining({
                values: [
                  expect.objectContaining({
                    images: [{ caption: "Value", file: { url: "https://cdn.example/value.jpg" } }],
                  }),
                ],
              }),
            ],
          }),
        }),
      ]),
    );
  });
});
