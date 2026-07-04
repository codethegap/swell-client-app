import { bulkUpsert, type IgnoredRecord } from "./batch";
import { loadImage, getFirstUrl, uploadImages, type UploadedFile } from "./image";
import { SkippableRecordError } from "./errors";
import { modelLinks } from "../constants";
import { stableId } from "./stable-id";

/** Imports categories, idempotently keyed by `slug`, resolving the parent by slug. */
export async function createCategories(
  req: SwellRequest,
  { records, importId }: { records: any[]; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const { swell } = req;
  const rehostImages = !isWorkflowRequest(req);

  const baseResult = await bulkUpsert(swell, {
    records,
    collection: "/categories",
    keyOf: (record) => record.slug,
    appData: req.appValues({ import_id: importId }),
    buildData: (record) =>
      buildCategoryData(swell, record, { resolveParent: false, rehostImages }),
  });

  const parentRecords = records.filter((record) => record[modelLinks.CATEGORY_BY_SLUG]);
  const parentResult = await bulkUpsert(swell, {
    records: parentRecords,
    collection: "/categories",
    keyOf: (record) => record.slug,
    appData: req.appValues({ import_id: importId }),
    buildData: (record) => buildCategoryParentData(swell, record),
  });

  return {
    ignoredRecords: [...baseResult.ignoredRecords, ...parentResult.ignoredRecords],
  };
}

async function buildCategoryData(
  swell: SwellAPI,
  record: any,
  {
    resolveParent = true,
    rehostImages = true,
  }: { resolveParent?: boolean; rehostImages?: boolean } = {},
): Promise<Record<string, unknown>> {
  const categoryData: any = { ...record };

  if (rehostImages && record.images) {
    categoryData.images = await uploadCategoryImages(swell, record.images);
  }

  if (resolveParent && record[modelLinks.CATEGORY_BY_SLUG]) {
    categoryData.parent_id = await resolveParentCategoryId(swell, record);
  }

  delete categoryData[modelLinks.CATEGORY_BY_SLUG];

  return categoryData;
}

function isWorkflowRequest(req: SwellRequest): boolean {
  return (req as unknown as { isWorkflow?: boolean }).isWorkflow === true;
}

async function buildCategoryParentData(
  swell: SwellAPI,
  record: any,
): Promise<Record<string, unknown>> {
  return {
    parent_id: await resolveParentCategoryId(swell, record),
  };
}

async function resolveParentCategoryId(swell: SwellAPI, record: any): Promise<string> {
  const parentSlug = record[modelLinks.CATEGORY_BY_SLUG];
  const parentId = await fetchParentCategoryId(swell, parentSlug);

  if (!parentId) {
    throw new SkippableRecordError("Parent category not found", {
      parent_slug: parentSlug,
    });
  }

  return parentId;
}

/**
 * Creates product↔category links. The join row is idempotent after resolving
 * category/product slugs because Swell enforces one `product_id` per
 * `parent_id`; existing links are PUT, new links are POST.
 */
export async function createCategoryLinks(
  req: SwellRequest,
  { records }: { records: any[]; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const { swell } = req;

  return bulkUpsert(swell, {
    records,
    collection: "/categories:products",
    keyOf: (_record, data) => (typeof data.id === "string" ? data.id : null),
    buildData: (record) => buildCategoryLinkData(swell, record),
  });
}

async function buildCategoryLinkData(swell: SwellAPI, record: any): Promise<Record<string, unknown>> {
  const linkData: any = { ...record, $migrate: false };

  if (
    record[modelLinks.CATEGORY_BY_SLUG] &&
    (record[modelLinks.PRODUCT_BY_SKU] || record[modelLinks.PRODUCT_BY_SLUG])
  ) {
    const [categoryId, productId] = await Promise.all([
      fetchParentCategoryId(swell, record[modelLinks.CATEGORY_BY_SLUG]),
      fetchProductId(swell, {
        sku: record[modelLinks.PRODUCT_BY_SKU],
        slug: record[modelLinks.PRODUCT_BY_SLUG],
      }),
    ]);

    if (!categoryId) {
      throw new SkippableRecordError("Parent category not found", {
        parent_slug: record[modelLinks.CATEGORY_BY_SLUG],
      });
    }

    if (!productId) {
      throw new SkippableRecordError("Product to link not found", {
        product_sku: record[modelLinks.PRODUCT_BY_SKU],
        product_slug: record[modelLinks.PRODUCT_BY_SLUG],
      });
    }

    linkData.parent_id = categoryId;
    linkData.product_id = productId;

    const existingLinkId = await fetchCategoryProductLinkId(swell, categoryId, productId);
    linkData.id = existingLinkId || (await stableId("category-product", categoryId, productId));
  }

  delete linkData[modelLinks.CATEGORY_BY_SLUG];
  delete linkData[modelLinks.PRODUCT_BY_SKU];
  delete linkData[modelLinks.PRODUCT_BY_SLUG];

  return linkData;
}

/** Supports both the array image shape and the `{ main: { url, alt } }` object shape. */
async function uploadCategoryImages(
  swell: SwellAPI,
  images: any,
): Promise<Array<{ caption: string; file: UploadedFile }>> {
  if (Array.isArray(images)) {
    return uploadImages(swell, images);
  }

  if (!images?.main?.url || images.main.url === "None") {
    return [];
  }

  try {
    const file = await loadImage(swell, getFirstUrl(images.main.url));
    return [{ caption: images.main.alt || "", file: { id: file.id, url: file.url } }];
  } catch {
    return [];
  }
}

function fetchParentCategoryId(swell: SwellAPI, slug: string): Promise<string | null> {
  return swell.get(`/categories/${slug}/id`);
}

async function fetchProductId(
  swell: SwellAPI,
  { sku, slug }: { sku?: string; slug?: string },
): Promise<string | null> {
  const friendlyId = slug || sku;

  const products = await swell.get("/products", {
    $or: [{ slug: friendlyId }, { sku: friendlyId }],
    fields: ["id"],
  });

  if (products?.results?.length) {
    return products.results[0].id;
  }

  return null;
}

async function fetchCategoryProductLinkId(
  swell: SwellAPI,
  categoryId: string,
  productId: string,
): Promise<string | null> {
  const links = await swell.get("/categories:products", {
    parent_id: categoryId,
    product_id: productId,
    fields: ["id"],
    limit: 1,
  });

  return links?.results?.[0]?.id ?? null;
}
