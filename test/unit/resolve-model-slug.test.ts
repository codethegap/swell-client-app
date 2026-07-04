import { describe, expect, it } from "vitest";
import { modelSlugs, resolveModelSlug } from "../../functions/constants";

describe("resolveModelSlug", () => {
  it("uses name and description when FlexiPort returns opaque export ids", () => {
    expect(resolveModelSlug({ id: "578005e0ff85", name: "Customers" })).toBe(
      modelSlugs.CUSTOMERS,
    );
    expect(resolveModelSlug({ id: "70ad88c752b4", description: "Swell orders export" })).toBe(
      modelSlugs.ORDERS,
    );
    expect(resolveModelSlug({ id: "opaque", slug: "swell_base_products" })).toBe(
      modelSlugs.PRODUCTS,
    );
  });

  it("does not let prose descriptions override explicit export names", () => {
    expect(
      resolveModelSlug({
        id: "61408fa6fe7e",
        name: "Categories",
        description: "Hierarchical product categories in Swell.",
      }),
    ).toBe(modelSlugs.CATEGORIES);
    expect(
      resolveModelSlug({
        id: "c1efc4435d45",
        name: "Orders",
        description: "Swell orders that include customer details.",
      }),
    ).toBe(modelSlugs.ORDERS);
  });

  it("distinguishes product-shaped specialized exports before base products", () => {
    expect(resolveModelSlug({ name: "Product variants" })).toBe(modelSlugs.PRODUCTS_VARIANTS);
    expect(resolveModelSlug({ name: "Product options" })).toBe(modelSlugs.PRODUCTS_OPTIONS);
    expect(resolveModelSlug({ name: "Product bundles" })).toBe(modelSlugs.PRODUCTS_BUNDLES);
  });
});
