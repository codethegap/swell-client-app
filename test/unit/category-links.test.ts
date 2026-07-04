import { describe, expect, it, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { createCategoryLinks } from "../../functions/utils/category";

describe("createCategoryLinks", () => {
  it("uses a deterministic id for new links so retries do not POST duplicates", async () => {
    const get = vi.fn(async (url: string, query?: any) => {
      if (url === "/categories/cat-a/id") return "cat_id";
      if (url === "/products") {
        expect(query.$or).toBeDefined();
        return { results: [{ id: "prod_id" }] };
      }
      if (url === "/categories:products") return { results: [] };
      throw new Error(`Unexpected get ${url}`);
    });
    const post = vi.fn(async (url: string, ops: any[]) => {
      expect(url).toBe("/:batch");
      return Object.fromEntries(ops.map((_op, i) => [String(i), { id: `ok_${i}` }]));
    });

    const req = createMockRequest({ swell: { get, post } });
    await createCategoryLinks(req, {
      importId: "import_1",
      records: [
        {
          "parent_id@by_category_slug": "cat-a",
          "product_id@by_product_slug": "prod-a",
        },
      ],
    });

    const ops = post.mock.calls[0][1];
    expect(ops).toHaveLength(1);
    expect(ops[0].method).toBe("put");
    expect(ops[0].url).toMatch(/^\/categories:products\/[0-9a-f]{24}$/);
    expect(ops[0].data).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      parent_id: "cat_id",
      product_id: "prod_id",
    });
  });
});
