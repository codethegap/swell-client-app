import { bulkUpsert, type IgnoredRecord } from "./batch";
import { uploadImages, type UploadedFile } from "./image";
import { keyBy, underscore } from "./index";
import { modelLinks } from "../constants";

const STOCK_UPDATE_CONCURRENCY = 8;
type StockTarget = { variant_id?: string; quantity: unknown };

/**
 * Imports products (and the product-shaped bundle/variant/option exports) into
 * Swell, idempotently keyed by `slug`. Images are rehosted and bundle items are
 * resolved to Swell product ids before the batch upsert.
 */
export async function createProducts(
  req: SwellRequest,
  { records, importId }: { records: any[]; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const { swell } = req;
  const rehostImages = !isWorkflowRequest(req);

  const result = await bulkUpsert(swell, {
    records,
    collection: "/products",
    keyOf: (record) => record.slug,
    appData: req.appValues({ import_id: importId }),
    buildData: (record) => buildProductData(swell, record, { rehostImages }),
  });

  const ignoredSlugs = new Set(result.ignoredRecords.map((record) => record.slug).filter(Boolean));
  const stockIgnoredRecords = await reconcileProductStock(
    swell,
    records.filter((record) => !ignoredSlugs.has(record.slug)),
  );

  return {
    ignoredRecords: [...result.ignoredRecords, ...stockIgnoredRecords],
  };
}

async function buildProductData(
  swell: SwellAPI,
  record: any,
  { rehostImages }: { rehostImages: boolean },
): Promise<Record<string, unknown>> {
  const productData: any = { ...record };
  delete productData.__stock;

  if (rehostImages && record.images) {
    productData.images = await uploadImages(swell, record.images);
  }

  if (record.bundle_items?.length > 0) {
    productData.bundle_items = await createBundleItems(swell, record.bundle_items);
  }

  if (record.variants?.length > 0) {
    productData.variants = await buildVariants(swell, record.variants, { rehostImages });
  }

  if (record.options?.length > 0) {
    productData.options = await buildOptions(swell, record.options, { rehostImages });
  }

  if (record.attributes) {
    productData.attributes = transformAttributes(record.attributes);
  }

  return productData;
}

async function reconcileProductStock(swell: SwellAPI, records: any[]): Promise<IgnoredRecord[]> {
  const ignoredRecords: IgnoredRecord[] = [];

  for (const record of records) {
    if (!Array.isArray(record.__stock) || record.__stock.length === 0 || !record.slug) {
      continue;
    }

    try {
      const product = await swell.get(`/products/${record.slug}`, {
        fields: ["id", "slug"],
      });

      if (!product?.id) {
        ignoredRecords.push({
          name: record.name,
          slug: record.slug,
          error: "Product not found for stock import",
        });
        continue;
      }

      const existingStockLevels = await getStockLevelsByVariant(swell, product.id);

      const stockTargets = record.__stock as StockTarget[];
      await runWithConcurrency(stockTargets, STOCK_UPDATE_CONCURRENCY, (target) =>
        reconcileStockTarget(swell, {
          productId: product.id,
          variantId: target.variant_id,
          quantity: target.quantity,
          currentQuantity: existingStockLevels.get(stockLevelKey(target.variant_id)) ?? 0,
        }),
      );
    } catch (err) {
      ignoredRecords.push({
        name: record.name,
        slug: record.slug,
        error: `Stock import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return ignoredRecords;
}

async function getStockLevelsByVariant(swell: SwellAPI, productId: string): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  const limit = 1000;
  let page = 1;

  while (true) {
    const stock = await swell.get("/products:stock", {
      parent_id: productId,
      fields: ["variant_id", "quantity"],
      limit,
      page,
    });
    const results = Array.isArray(stock?.results) ? stock.results : [];

    for (const record of results) {
      const quantity = Number(record?.quantity ?? 0);
      if (!Number.isFinite(quantity)) continue;

      const key = stockLevelKey(record?.variant_id);
      levels.set(key, (levels.get(key) ?? 0) + quantity);
    }

    const pageCount = Number(stock?.page_count ?? 0);
    if (results.length < limit || pageCount <= page) break;
    page += 1;
  }

  return levels;
}

async function reconcileStockTarget(
  swell: SwellAPI,
  {
    productId,
    variantId,
    quantity,
    currentQuantity,
  }: { productId: string; variantId?: string; quantity: unknown; currentQuantity: number },
): Promise<void> {
  const targetQuantity = Number(quantity);
  if (!Number.isFinite(targetQuantity)) return;

  const delta = targetQuantity - currentQuantity;
  if (delta === 0) return;

  await swell.post(`/products/${productId}/stock`, {
    ...(variantId ? { variant_id: variantId } : {}),
    quantity: delta,
    reason: delta > 0 ? "received" : "missing",
    description: `FlexiPort stock sync: set source quantity to ${targetQuantity}`,
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += concurrency) {
    await Promise.all(items.slice(index, index + concurrency).map(worker));
  }
}

function stockLevelKey(variantId: unknown): string {
  return typeof variantId === "string" && variantId ? variantId : "__base__";
}

async function buildVariants(
  swell: SwellAPI,
  variants: any[],
  { rehostImages }: { rehostImages: boolean },
): Promise<any[]> {
  const result: any[] = [];

  for (const variant of variants) {
    const variantData: any = { ...variant };

    if (rehostImages && variant.images?.length > 0) {
      variantData.images = await uploadImages(swell, variant.images);
    }

    if (variant.attributes) {
      variantData.attributes = transformAttributes(variant.attributes);
    }

    result.push(variantData);
  }

  return result;
}

async function buildOptions(
  swell: SwellAPI,
  options: any[],
  { rehostImages }: { rehostImages: boolean },
): Promise<any[]> {
  const result: any[] = [];

  for (const option of options) {
    const optionData: any = { ...option };

    if (option.values?.length > 0) {
      const values: any[] = [];

      for (const value of option.values) {
        const valueData: any = { ...value };

        if (rehostImages && value.images?.length > 0) {
          const uploaded = await uploadImages(swell, value.images);
          valueData.images = uploaded;

          if (uploaded.length > 0) {
            valueData.image = uploaded[0].file;
          }
        }

        values.push(valueData);
      }

      optionData.values = values;
    }

    result.push(optionData);
  }

  return result;
}

function isWorkflowRequest(req: SwellRequest): boolean {
  return (req as unknown as { isWorkflow?: boolean }).isWorkflow === true;
}

/**
 * Resolves bundle item references (by product slug or sku) to Swell product ids.
 * NOTE: capped at 50 referenced products per record (rare to exceed for a bundle).
 */
async function createBundleItems(
  swell: SwellAPI,
  items: any[],
): Promise<Array<{ quantity: number; product_id: string }>> {
  const linkedBySlug = items[0][modelLinks.PRODUCT_BY_SLUG];
  const modelLink = linkedBySlug ? modelLinks.PRODUCT_BY_SLUG : modelLinks.PRODUCT_BY_SKU;

  const products = await swell.get("/products", {
    $or: [
      { slug: { $in: items.map((item) => item[modelLink]) } },
      { sku: { $in: items.map((item) => item[modelLink]) } },
    ],
    fields: ["id", "sku", "slug"],
    limit: 50,
  });

  const productsBySlug = keyBy(products.results, "slug");
  const productsBySku = keyBy(products.results, "sku");

  const newItems: Array<{ quantity: number; product_id: string }> = [];

  for (const item of items) {
    const product = productsBySlug[item[modelLink]] || productsBySku[item[modelLink]];

    if (product && product.id !== undefined) {
      newItems.push({ quantity: item.quantity, product_id: product.id });
    }
  }

  return newItems;
}

/**
 * Converts an array of `{ key, value }` attribute objects into an object keyed
 * by underscored attribute name.
 */
function transformAttributes(attributes: any): Record<string, unknown> {
  if (!Array.isArray(attributes)) return {};

  return attributes.reduce((result: Record<string, unknown>, attr: any) => {
    if (attr && attr.key && attr.value !== undefined) {
      result[underscore(attr.key)] = attr.value;
    }
    return result;
  }, {});
}
