import { describe, expect, it, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { createOrders } from "../../functions/utils/order";

describe("createOrders", () => {
  it("resolves accounts and item links once per page while preserving historical lines", async () => {
    const get = vi.fn(async (url: string, query?: any) => {
      if (url === "/accounts" && query?.email?.$in) {
        expect(query.email.$in).toContain("a@example.com");
        expect(query.email.$in).toContain("b@example.com");
        return { results: [{ id: "acc_a", email: "a@example.com" }] };
      }
      if (url === "/accounts/a@example.com/id") return "acc_a";
      if (url === "/accounts/b@example.com/id") return null;
      if (url === "/accounts") return { results: [] };
      if (url === "/products:variants") {
        expect(query.sku.$in).toContain("VAR-1");
        return {
          results: [{ id: "var_1", sku: "VAR-1", parent_id: "prod_parent" }],
        };
      }
      if (url === "/products" && query?.sku) {
        return {
          results: [{ id: "prod_2", sku: "P-2" }],
        };
      }
      if (url === "/products" && query?.id) {
        return {
          results: [{ id: "prod_parent", sku: "P-1" }],
        };
      }
      throw new Error(`Unexpected get ${url}`);
    });
    const put = vi.fn(async (url: string, data?: any) => {
      if (url === "/accounts/b%40example.com") {
        expect(data.email).toBe("b@example.com");
        return { id: "acc_b" };
      }
      throw new Error(`Unexpected put ${url}`);
    });
    const post = vi.fn(async (url: string, ops?: any[]) => {
      expect(url).toBe("/:batch");
      return Object.fromEntries((ops || []).map((_op, i) => [String(i), { id: `ok_${i}` }]));
    });

    const req = createMockRequest({ swell: { get, put, post } });
    const result = await createOrders(req, {
      importId: "import_1",
      records: [
        {
          number: "1001",
          "account_id@by_email": "a@example.com",
          items: [
            {
              "variant_id@by_variant_sku": "VAR-1",
              "product_id@by_product_sku": "P-1",
              quantity: 1,
              price: 10,
            },
            {
              "product_id@by_product_sku": "MISSING",
              product_name: "Historical line",
              quantity: 1,
              price: 4,
            },
          ],
        },
        {
          number: "1002",
          "account_id@by_email": "b@example.com",
          __account: { first_name: "Bee" },
          items: [
            {
              "product_id@by_product_sku": "P-2",
              quantity: 2,
              price: 5,
            },
          ],
        },
      ],
    });

    expect(result.ignoredRecords).toEqual([]);
    expect(get).toHaveBeenCalledWith("/products:variants", expect.any(Object));
    expect(get).toHaveBeenCalledWith("/products", expect.objectContaining({ sku: expect.any(Object) }));
    expect(get).toHaveBeenCalledWith("/products", expect.objectContaining({ id: expect.any(Object) }));
    expect(post).toHaveBeenCalledTimes(2);

    const migrateOps = post.mock.calls[0][1];
    expect(migrateOps).toHaveLength(2);
    expect(migrateOps[0].data.account_id).toBe("acc_a");
    expect(migrateOps[0].data.items[0]).toMatchObject({
      product_id: "prod_parent",
      variant_id: "var_1",
    });
    expect(migrateOps[0].data.items[1]).toMatchObject({
      product_name: "Historical line",
      quantity: 1,
      price: 4,
    });
    expect(migrateOps[0].data.items[1].product_id).toBeUndefined();
    expect(migrateOps[1].data.account_id).toBe("acc_b");

    const recalcOps = post.mock.calls[1][1];
    expect(recalcOps[0].data).toMatchObject({
      notify: false,
      taxes_fixed: true,
      hold: false,
      $events: false,
    });
  });

  it("skips the recalculation write for complete historical order snapshots", async () => {
    const get = vi.fn(async (url: string, query?: any) => {
      if (url === "/accounts" && query?.email?.$in) {
        return { results: [{ id: "acc_a", email: "a@example.com" }] };
      }
      if (url === "/products:variants" || url === "/products") {
        return { results: [] };
      }
      throw new Error(`Unexpected get ${url}`);
    });
    const post = vi.fn(async (url: string, ops?: any[]) => {
      expect(url).toBe("/:batch");
      return Object.fromEntries((ops || []).map((_op, i) => [String(i), { id: `ok_${i}` }]));
    });

    const req = createMockRequest({ swell: { get, post } });
    const result = await createOrders(req, {
      importId: "import_1",
      records: [
        {
          number: "1001",
          "account_id@by_email": "a@example.com",
          sub_total: 10,
          grand_total: 10,
          payment_balance: 0,
          item_quantity: 1,
          status: "complete",
          paid: true,
          delivered: true,
          items: [{ product_name: "Historical line", quantity: 1, price: 10 }],
        },
      ],
    });

    expect(result.ignoredRecords).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1][0].data).toMatchObject({
      $migrate: true,
      grand_total: 10,
      status: "complete",
      paid: true,
    });
  });
});
