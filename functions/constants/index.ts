/**
 * FlexiPort export "slug" -> the Swell import handler that processes it.
 * One pipeline export file maps to exactly one of these.
 */
export const modelSlugs = {
  PRODUCTS: "swell_base_products",
  PRODUCTS_BUNDLES: "swell_bundles_products",
  PRODUCTS_VARIANTS: "swell_variants_products",
  PRODUCTS_OPTIONS: "swell_options_products",
  CATEGORIES: "swell_categories",
  CATEGORIES_PRODUCTS: "swell_categorization",
  CUSTOMERS: "swell_customers",
  ORDERS: "swell_orders",
} as const;

export type ModelSlug = (typeof modelSlugs)[keyof typeof modelSlugs];

/**
 * Records pulled from FlexiPort per workflow page-step. Under the durable
 * import workflow a step is no longer bound by the 10s function timeout, so
 * these are far larger than the legacy value of 2. They are the single tuning
 * knob: raise for cheap entities, keep lower for image-heavy / multi-write ones
 * (products rehost images; orders resolve accounts + do two batch writes).
 * NOTE: starting points — validate against a real large export (Phase 0) and
 * tune. Throughput is ultimately gated by the plan's /:batch weight limit, not
 * page size.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_MAP: Partial<Record<ModelSlug, number>> = {
  [modelSlugs.CATEGORIES]: 50,
  [modelSlugs.CATEGORIES_PRODUCTS]: 100,
  [modelSlugs.CUSTOMERS]: 100,
  [modelSlugs.ORDERS]: 100,
};

export const MAX_RETRIES = 3;

export const fileStatuses = {
  PENDING: "pending",
  PROCESSING: "processing",
  FAILED: "failed",
  COMPLETED: "completed",
} as const;

export type FileStatus = (typeof fileStatuses)[keyof typeof fileStatuses];

export const systemStatuses = {
  SYNCING: "syncing",
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

export type SystemStatus = (typeof systemStatuses)[keyof typeof systemStatuses];

/**
 * Maps a FlexiPort export (manifest entry) to the canonical model slug that
 * routes it to a handler. The pipeline manifest only carries `{ id, table }`
 * (no explicit slug), so we resolve heuristically from those.
 *
 * NOTE (pipeline contract): confirm this mapping matches the real FlexiPort
 * export identifiers — getting it wrong silently skips an export.
 */
export function resolveModelSlug(exp: {
  id?: string;
  table?: string;
  slug?: string;
  name?: string;
  description?: string;
}): ModelSlug | null {
  const primary = [exp.slug, exp.name, exp.table, exp.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const description = (exp.description || "").toLowerCase();
  const key = `${primary} ${description}`;

  // Prefer manifest identity fields over prose descriptions. Descriptions often
  // mention related entities ("orders include customer details", "product
  // categories") and are too noisy to classify first.
  if (matchesAny(primary, ["categorization", "categories_products", "category products"])) {
    return modelSlugs.CATEGORIES_PRODUCTS;
  }
  if (matchesAny(primary, ["product variants", "variants_products", "variant"])) {
    return modelSlugs.PRODUCTS_VARIANTS;
  }
  if (matchesAny(primary, ["product options", "options_products", "option"])) {
    return modelSlugs.PRODUCTS_OPTIONS;
  }
  if (matchesAny(primary, ["product bundles", "bundles_products", "bundle"])) {
    return modelSlugs.PRODUCTS_BUNDLES;
  }
  if (matchesAny(primary, ["orders", "swell_orders", "order"])) return modelSlugs.ORDERS;
  if (matchesAny(primary, ["customers", "swell_customers", "customer"])) return modelSlugs.CUSTOMERS;
  if (matchesAny(primary, ["categories", "swell_categories", "category"])) return modelSlugs.CATEGORIES;
  if (matchesAny(primary, ["products", "swell_base_products", "product"])) return modelSlugs.PRODUCTS;

  if (
    key.includes("product/category link") ||
    key.includes("product-category link") ||
    key.includes("category link")
  ) {
    return modelSlugs.CATEGORIES_PRODUCTS;
  }
  if (key.includes("variant")) return modelSlugs.PRODUCTS_VARIANTS;
  if (key.includes("option")) return modelSlugs.PRODUCTS_OPTIONS;
  if (key.includes("bundle")) return modelSlugs.PRODUCTS_BUNDLES;
  if (key.includes("order")) return modelSlugs.ORDERS;
  if (key.includes("customer")) return modelSlugs.CUSTOMERS;
  if (key.includes("categor")) return modelSlugs.CATEGORIES;
  if (key.includes("product")) return modelSlugs.PRODUCTS;

  return null;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

/**
 * Processing order. Files are imported strictly in ascending priority (the
 * workflow sequencer runs one file at a time), so this encodes cross-file
 * dependencies: base products before bundles that reference them by slug/sku;
 * products + categories before category links; accounts (customers) before the
 * orders that reference them.
 */
export const SLUG_PRIORITY: Partial<Record<ModelSlug, number>> = {
  [modelSlugs.PRODUCTS]: 0,
  [modelSlugs.PRODUCTS_OPTIONS]: 1,
  [modelSlugs.PRODUCTS_VARIANTS]: 2,
  [modelSlugs.PRODUCTS_BUNDLES]: 3,
  [modelSlugs.CATEGORIES]: 4,
  [modelSlugs.CATEGORIES_PRODUCTS]: 5,
  [modelSlugs.CUSTOMERS]: 6,
  [modelSlugs.ORDERS]: 7,
};

/**
 * Synthetic link keys FlexiPort embeds on records so we can resolve a
 * human-friendly reference (slug / sku / email) to a Swell id at import time.
 */
export const modelLinks = {
  PRODUCT_BY_SLUG: "product_id@by_product_slug",
  PRODUCT_BY_SKU: "product_id@by_product_sku",
  CATEGORY_BY_SLUG: "parent_id@by_category_slug",
  ACCOUNT_BY_EMAIL: "account_id@by_email",
  VARIANT_BY_SKU: "variant_id@by_variant_sku",
} as const;
