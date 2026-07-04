import { fileStatuses, modelSlugs } from "../constants";
import { getFirstUrl, isSwellCdnUrl, loadImage, toFileObject } from "./image";

const PRODUCT_PAGE_LIMIT = 25;
const CATEGORY_PAGE_LIMIT = 50;

interface ImageBudget {
  remaining: number;
  processed: number;
  errors: number;
}

interface RehostSummary {
  processed: number;
  errors: number;
  productsCompleted: boolean;
  categoriesCompleted: boolean;
}

interface RehostResult<T> {
  changed: boolean;
  value: T;
}

export async function rehostImportImages(
  swell: SwellAPI,
  {
    importId,
    appId,
    maxImages = 5,
  }: { importId: string; appId: string; maxImages?: number },
): Promise<RehostSummary> {
  const [record, files] = await Promise.all([
    swell.get(`/imports/${importId}`, {
      fields: [
        "image_rehost_product_page",
        "image_rehost_category_page",
        "image_rehost_products_completed",
        "image_rehost_categories_completed",
        "image_rehost_processed_count",
        "image_rehost_error_count",
      ],
    }),
    listImportFiles(swell, importId),
  ]);

  const productFileCompleted = files.some(
    (file) => isProductFile(file) && file.status === fileStatuses.COMPLETED,
  );
  const categoryFileCompleted = files.some(
    (file) => file.slug === modelSlugs.CATEGORIES && file.status === fileStatuses.COMPLETED,
  );
  const hasProductFile = files.some(isProductFile);
  const hasCategoryFile = files.some((file) => file.slug === modelSlugs.CATEGORIES);

  const budget: ImageBudget = {
    remaining: Math.max(0, maxImages),
    processed: 0,
    errors: 0,
  };
  const updates: Record<string, unknown> = {};

  let productsCompleted =
    record?.image_rehost_products_completed === true || !hasProductFile;
  let categoriesCompleted =
    record?.image_rehost_categories_completed === true || !hasCategoryFile;

  if (budget.remaining > 0 && productFileCompleted && !productsCompleted) {
    const page = Number(record?.image_rehost_product_page || 1);
    const result = await processProducts(swell, {
      importId,
      appId,
      page,
      budget,
    });
    updates.image_rehost_product_page = result.nextPage;
    if (result.completed) {
      productsCompleted = true;
      updates.image_rehost_products_completed = true;
    }
  }

  if (budget.remaining > 0 && categoryFileCompleted && !categoriesCompleted) {
    const page = Number(record?.image_rehost_category_page || 1);
    const result = await processCategories(swell, {
      importId,
      appId,
      page,
      budget,
    });
    updates.image_rehost_category_page = result.nextPage;
    if (result.completed) {
      categoriesCompleted = true;
      updates.image_rehost_categories_completed = true;
    }
  }

  if (budget.processed > 0 || budget.errors > 0 || Object.keys(updates).length > 0) {
    updates.image_rehost_processed_count =
      Number(record?.image_rehost_processed_count || 0) + budget.processed;
    updates.image_rehost_error_count =
      Number(record?.image_rehost_error_count || 0) + budget.errors;
  }

  if (productsCompleted && categoriesCompleted && !record?.date_images_completed) {
    updates.date_images_completed = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) {
    await swell.put(`/imports/${importId}`, { $set: updates, $events: false });
  }

  console.log(
    `rehost import=${importId} processed=${budget.processed} errors=${budget.errors} ` +
      `products=${productsCompleted ? "done" : `page ${updates.image_rehost_product_page ?? "-"}`} ` +
      `categories=${categoriesCompleted ? "done" : `page ${updates.image_rehost_category_page ?? "-"}`}`,
  );

  return {
    processed: budget.processed,
    errors: budget.errors,
    productsCompleted,
    categoriesCompleted,
  };
}

async function processProducts(
  swell: SwellAPI,
  {
    importId,
    appId,
    page,
    budget,
  }: { importId: string; appId: string; page: number; budget: ImageBudget },
): Promise<{ nextPage: number; completed: boolean }> {
  let currentPage = Math.max(1, page);

  while (budget.remaining > 0) {
    // Full records (no `fields`): the projection cannot include `$app` (Mongo
    // rejects `$`-prefixed field paths), and `$app.<id>` query filters use a
    // store-specific storage key we cannot know portably. So we page the whole
    // collection and match this import's records client-side via the
    // slug-keyed `$app` object that every response carries.
    const result = await swell.get("/products", {
      limit: PRODUCT_PAGE_LIMIT,
      page: currentPage,
    });
    const products = Array.isArray(result?.results) ? result.results : [];
    if (products.length === 0) {
      return { nextPage: 1, completed: true };
    }

    for (const product of products) {
      if (budget.remaining <= 0) break;
      if (!belongsToImport(product, appId, importId)) continue;

      const set: Record<string, unknown> = {};
      const images = await rehostImageList(swell, product.images, budget);
      if (images.changed) set.images = images.value;

      const options = await rehostProductOptions(swell, product.options, budget);
      if (options.changed) set.options = options.value;

      if (Object.keys(set).length > 0) {
        await swell.put(`/products/${product.id}`, { $set: set, $events: false });
      }

      await rehostProductVariants(swell, product.id, budget);
    }

    if (budget.remaining <= 0) {
      return { nextPage: currentPage, completed: false };
    }

    const pageCount = Number(result?.page_count || 0);
    if (products.length < PRODUCT_PAGE_LIMIT || pageCount <= currentPage) {
      return { nextPage: 1, completed: true };
    }
    currentPage += 1;
  }

  return { nextPage: currentPage, completed: false };
}

async function processCategories(
  swell: SwellAPI,
  {
    importId,
    appId,
    page,
    budget,
  }: { importId: string; appId: string; page: number; budget: ImageBudget },
): Promise<{ nextPage: number; completed: boolean }> {
  let currentPage = Math.max(1, page);

  while (budget.remaining > 0) {
    // Full records + client-side match — see the note in processProducts.
    const result = await swell.get("/categories", {
      limit: CATEGORY_PAGE_LIMIT,
      page: currentPage,
    });
    const categories = Array.isArray(result?.results) ? result.results : [];
    if (categories.length === 0) {
      return { nextPage: 1, completed: true };
    }

    for (const category of categories) {
      if (budget.remaining <= 0) break;
      if (!belongsToImport(category, appId, importId)) continue;

      const images = await rehostImageList(swell, category.images, budget);
      if (images.changed) {
        await swell.put(`/categories/${category.id}`, {
          $set: { images: images.value },
          $events: false,
        });
      }
    }

    if (budget.remaining <= 0) {
      return { nextPage: currentPage, completed: false };
    }

    const pageCount = Number(result?.page_count || 0);
    if (categories.length < CATEGORY_PAGE_LIMIT || pageCount <= currentPage) {
      return { nextPage: 1, completed: true };
    }
    currentPage += 1;
  }

  return { nextPage: currentPage, completed: false };
}

async function rehostProductOptions(
  swell: SwellAPI,
  options: any,
  budget: ImageBudget,
): Promise<RehostResult<any[]>> {
  if (!Array.isArray(options) || options.length === 0) {
    return { changed: false, value: options };
  }

  let changed = false;
  const nextOptions = [];
  for (const option of options) {
    const nextOption = { ...option };
    if (Array.isArray(option.values)) {
      const nextValues = [];
      for (const value of option.values) {
        const nextValue = { ...value };
        const images = await rehostImageList(swell, value.images, budget);
        if (images.changed) {
          nextValue.images = images.value;
          nextValue.image = images.value[0]?.file ?? null;
          changed = true;
        }
        nextValues.push(nextValue);
      }
      nextOption.values = nextValues;
    }
    nextOptions.push(nextOption);
  }

  return { changed, value: nextOptions };
}

async function rehostProductVariants(
  swell: SwellAPI,
  productId: string,
  budget: ImageBudget,
): Promise<void> {
  if (budget.remaining <= 0) return;

  const result = await swell.get("/products:variants", {
    parent_id: productId,
    fields: ["id", "images"],
    limit: 100,
  });
  const variants = Array.isArray(result?.results) ? result.results : [];

  for (const variant of variants) {
    if (budget.remaining <= 0) return;

    const images = await rehostImageList(swell, variant.images, budget);
    if (images.changed) {
      await swell.put(`/products:variants/${variant.id}`, {
        $set: { images: images.value },
        $events: false,
      });
    }
  }
}

async function rehostImageList(
  swell: SwellAPI,
  images: any,
  budget: ImageBudget,
): Promise<RehostResult<any[]>> {
  if (!Array.isArray(images) || images.length === 0) {
    return { changed: false, value: Array.isArray(images) ? images : [] };
  }

  let changed = false;
  const nextImages = [];

  for (const image of images) {
    const sourceUrl = getFirstUrl(image?.file?.url);
    if (!sourceUrl || sourceUrl === "None" || isSwellCdnUrl(sourceUrl)) {
      nextImages.push(image);
      continue;
    }

    if (budget.remaining <= 0) {
      nextImages.push(image);
      continue;
    }

    budget.remaining -= 1;
    try {
      const file = await loadImage(swell, sourceUrl);
      nextImages.push({ ...image, file: toFileObject(file) });
      budget.processed += 1;
      changed = true;
    } catch {
      // Match the import-time image behavior: one bad image is dropped, not
      // allowed to poison the whole product/category forever.
      budget.errors += 1;
      changed = true;
    }
  }

  return { changed, value: nextImages };
}

/**
 * Whether a standard-collection record was written by this import. App
 * extension values always serialize in responses as `$app.<app_id>.*` keyed by
 * the app's string id, which is stable across stores (unlike the `$app` query
 * key, which is a per-store installed-app ObjectId).
 */
function belongsToImport(record: any, appId: string, importId: string): boolean {
  return record?.$app?.[appId]?.import_id === importId;
}

async function listImportFiles(swell: SwellAPI, importId: string): Promise<any[]> {
  const result = await swell.get("/imports:files", {
    parent_id: importId,
    fields: ["slug", "status"],
    limit: 1000,
  });
  return Array.isArray(result?.results) ? result.results : [];
}

function isProductFile(file: any): boolean {
  return [
    modelSlugs.PRODUCTS,
    modelSlugs.PRODUCTS_BUNDLES,
    modelSlugs.PRODUCTS_OPTIONS,
    modelSlugs.PRODUCTS_VARIANTS,
  ].includes(file?.slug);
}
