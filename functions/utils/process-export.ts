import { modelSlugs, type ModelSlug } from "../constants";
import { getUserFriendlyError, isPermanentError } from "./errors";
import { markImportError } from "./import-status";
import { createProducts } from "./product";
import { createCategories, createCategoryLinks } from "./category";
import { createCustomers } from "./customer";
import { createOrders } from "./order";
import type { IgnoredRecord } from "./batch";

/** Product-shaped exports that carry a separate attributes payload to reconcile on page 1. */
export const modelsWithAttributes: ModelSlug[] = [
  modelSlugs.PRODUCTS,
  modelSlugs.PRODUCTS_OPTIONS,
  modelSlugs.PRODUCTS_VARIANTS,
];

/**
 * Routes one page of records to the handler for its slug. Handlers only use
 * `req.swell` and `req.appValues`, so a workflow may pass a request-shaped
 * adapter here (see functions/flexiport-file-import.ts).
 */
export function processExportData(
  req: SwellRequest,
  { records, slug, importId }: { records: any[]; slug: ModelSlug; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  switch (slug) {
    case modelSlugs.PRODUCTS:
    case modelSlugs.PRODUCTS_BUNDLES:
    case modelSlugs.PRODUCTS_OPTIONS:
    case modelSlugs.PRODUCTS_VARIANTS:
      return createProducts(req, { records, importId });

    case modelSlugs.CATEGORIES:
      return createCategories(req, { records, importId });

    case modelSlugs.CATEGORIES_PRODUCTS:
      return createCategoryLinks(req, { records, importId });

    case modelSlugs.CUSTOMERS:
      return createCustomers(req, { records, importId });

    case modelSlugs.ORDERS:
      return createOrders(req, { records, importId });

    default:
      return Promise.resolve({ ignoredRecords: [] });
  }
}

/**
 * Runs a FlexiPort call. A permanent error (bad key / 4xx) halts the import and
 * stops retries; a transient error propagates so the caller retries.
 */
export async function fetchFlexiport<T>(
  swell: SwellAPI,
  importId: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isPermanentError(err)) {
      const message = getUserFriendlyError(err);
      await markImportError(swell, importId, message);
      throw new SwellError(message, { status: 400, retry: false });
    }
    throw err;
  }
}
