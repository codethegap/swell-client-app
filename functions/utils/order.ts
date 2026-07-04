import { runBatch, type BatchOp, type IgnoredRecord } from "./batch";
import { SkippableRecordError } from "./errors";
import { keyBy } from "./index";
import { modelLinks } from "../constants";

const LOOKUP_CHUNK_SIZE = 50;
const ORDER_WRITE_BATCH_CHUNK = 2;
const HISTORICAL_SNAPSHOT_FIELDS = [
  "sub_total",
  "grand_total",
  "payment_balance",
  "item_quantity",
  "status",
] as const;

interface AccountResolution {
  id?: string;
  error?: string;
  details?: unknown;
}

/**
 * Imports historical orders, idempotently keyed by the source order `number`
 * (FlexiPort exports are pre-shaped to Swell's schema). `$migrate` preserves the
 * original `date_created` and skips order events/notifications/inventory effects.
 */
export async function createOrders(
  req: SwellRequest,
  { records, importId }: { records: any[]; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const { swell } = req;
  const appData = req.appValues({ import_id: importId });
  const ignoredRecords: IgnoredRecord[] = [];
  const migrateOps: BatchOp[] = [];
  const recalculateOps: Array<BatchOp | null> = [];
  const opSources: any[] = [];
  const accounts = await resolveAccounts(swell, records, appData);
  const itemResolver = await createItemResolver(swell, records);

  for (const record of records) {
    try {
      const key = record.number;
      if (!key) {
        throw new SkippableRecordError("Order number missing");
      }

      const data = buildOrderData(record, appData, { accounts, itemResolver });
      const url = `/orders/${encodeURIComponent(key)}`;

      migrateOps.push({
        method: "put",
        url,
        data: { $migrate: true, ...data, ...appData },
      });

      recalculateOps.push(
        shouldRecalculateOrder(data)
          ? {
              method: "put",
              url,
              data: { ...buildRecalculateData(data), ...appData },
            }
          : null,
      );
      opSources.push(record);
    } catch (err) {
      if (err instanceof SkippableRecordError) {
        ignoredRecords.push({
          name: record.number,
          error: err.message,
          details: err.details,
        });
      } else {
        throw err;
      }
    }
  }

  const migrateResults = await runBatch(swell, migrateOps, ORDER_WRITE_BATCH_CHUNK);
  const seenErrors = new Set<string>();
  const successfulRecalculateOps: BatchOp[] = [];
  const successfulRecalculateSources: any[] = [];

  migrateResults.forEach((result, i) => {
    if (result && typeof result === "object" && "$error" in result) {
      const source = opSources[i];
      const message = String((result as { $error: unknown }).$error);
      const key = `${source?.number || i}:${message}`;
      if (!seenErrors.has(key)) {
        seenErrors.add(key);
        ignoredRecords.push({
          name: source?.number,
          error: message,
        });
      }
    } else {
      const recalculateOp = recalculateOps[i];
      if (recalculateOp) {
        successfulRecalculateOps.push(recalculateOp);
        successfulRecalculateSources.push(opSources[i]);
      }
    }
  });

  const recalculateResults = await runBatch(
    swell,
    successfulRecalculateOps,
    ORDER_WRITE_BATCH_CHUNK,
  );
  recalculateResults.forEach((result, i) => {
    if (result && typeof result === "object" && "$error" in result) {
      const source = successfulRecalculateSources[i];
      const message = String((result as { $error: unknown }).$error);
      const key = `${source?.number || i}:${message}`;
      if (!seenErrors.has(key)) {
        seenErrors.add(key);
        ignoredRecords.push({
          name: source?.number,
          error: message,
        });
      }
    }
  });

  return { ignoredRecords };
}

function buildOrderData(
  record: any,
  appData: Record<string, unknown>,
  context: {
    accounts: Map<string, AccountResolution>;
    itemResolver: { resolveItems(items: any[]): any[] };
  },
): Record<string, unknown> {
  const orderData: any = {
    ...record,
    ...(record.canceled ? { canceled: true } : {}),
    ...(record.refund_marked ? { refund_marked: true } : {}),
    ...(record.delivery_marked ? { delivery_marked: true } : {}),
    ...(record.payment_marked ? { payment_marked: true } : {}),
    ...(record.draft ? { draft: true } : {}),
    ...(record.hold ? { hold: true } : {}),
    ...(record.gift ? { gift: true } : {}),
    notify: false,
    taxes_fixed: true,
  };
  // Historical Shopify discount codes are not guaranteed to exist as Swell
  // coupons. Keep them in metadata, but clear Swell's live coupon field so
  // recalculation does not validate stale coupon ids/codes.
  orderData.coupon_code = null;

  if (record[modelLinks.ACCOUNT_BY_EMAIL]) {
    const email = record[modelLinks.ACCOUNT_BY_EMAIL];
    const account = context.accounts.get(normalizeEmail(email));
    const accountId = account?.id;

    if (!accountId) {
      throw new SkippableRecordError(account?.error || "Account not found", {
        email,
        details: account?.details,
      });
    }

    orderData.account_id = accountId;
  }

  if (record.items?.length > 0) {
    orderData.items = context.itemResolver.resolveItems(record.items);
  }

  // Drop FlexiPort's synthetic link annotations so they are not stored.
  delete orderData[modelLinks.ACCOUNT_BY_EMAIL];
  delete orderData.__account;

  return orderData;
}

function buildRecalculateData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    notify: false,
    taxes_fixed: true,
    hold: false,
    coupon_code: null,
    $events: false,
  };

  for (const key of [
    "payment_marked",
    "refund_marked",
    "delivery_marked",
    "canceled",
    "draft",
    "hold",
    "gift",
  ]) {
    if (key in data) {
      out[key] = data[key] === true;
    }
  }

  return out;
}

async function fetchAccountId(swell: SwellAPI, email: string): Promise<string | null> {
  const direct = await swell.get(`/accounts/${email}/id`);
  if (direct) {
    return direct;
  }

  const result = await swell.get("/accounts", {
    email,
    fields: ["id", "email"],
    limit: 1,
  });
  return result?.results?.[0]?.id || null;
}

async function resolveAccounts(
  swell: SwellAPI,
  records: any[],
  appData: Record<string, unknown>,
): Promise<Map<string, AccountResolution>> {
  const accountHints = new Map<string, any>();
  for (const record of records) {
    const email = record?.[modelLinks.ACCOUNT_BY_EMAIL];
    const normalized = normalizeEmail(email);
    if (normalized && !accountHints.has(normalized)) {
      accountHints.set(normalized, record.__account);
    }
  }

  const results = new Map<string, AccountResolution>();
  const existingAccounts = await fetchMany(swell, "/accounts", "email", [...accountHints.keys()], [
    "id",
    "email",
  ]);
  for (const account of existingAccounts) {
    if (account?.id && account?.email) {
      results.set(normalizeEmail(account.email), { id: account.id });
    }
  }

  await Promise.all(
    [...accountHints.entries()].map(async ([email, accountHint]) => {
      try {
        if (results.has(normalizeEmail(email))) {
          return;
        }

        const existingId = await fetchAccountId(swell, email);
        if (existingId) {
          results.set(normalizeEmail(email), { id: existingId });
          return;
        }

        const accountData = {
          group: "customer",
          type: "individual",
          name: email.split("@")[0],
          ...accountHint,
          email,
          ...appData,
        };

        let account: any;
        try {
          account = await swell.put(`/accounts/${encodeURIComponent(email)}`, accountData);
        } catch (err) {
          const accountId = await fetchAccountId(swell, email);
          if (accountId) {
            results.set(email, { id: accountId });
            return;
          }
          throw err;
        }

        if (account && typeof account === "object" && "$error" in account) {
          const accountId = await fetchAccountId(swell, email);
          if (accountId) {
            results.set(email, { id: accountId });
            return;
          }
          results.set(email, {
            error: "Account create failed",
            details: account.$error,
          });
          return;
        }

        const accountId = account?.id || (await fetchAccountId(swell, email));
        results.set(
          email,
          accountId
            ? { id: accountId }
            : { error: "Account create failed", details: "No account id returned" },
        );
      } catch (err) {
        results.set(normalizeEmail(email), {
          error: "Account resolve failed",
          details: getErrorDetails(err),
        });
      }
    }),
  );

  return results;
}

function shouldRecalculateOrder(data: Record<string, unknown>): boolean {
  return !HISTORICAL_SNAPSHOT_FIELDS.every((field) => data[field] !== undefined && data[field] !== null);
}

function normalizeEmail(email: unknown): string {
  return String(email || "").trim().toLowerCase();
}

function getErrorDetails(err: unknown): unknown {
  if (!err || typeof err !== "object") {
    return String(err);
  }
  const e = err as { message?: unknown; body?: unknown; status?: unknown };
  return e.body || e.message || e.status || String(err);
}

/**
 * Resolves order line items (by product sku, optional variant by sku) to Swell
 * product/variant ids once per page, then maps each order line locally.
 */
async function createItemResolver(
  swell: SwellAPI,
  records: any[],
): Promise<{ resolveItems(items: any[]): any[] }> {
  const skus = [
    ...new Set(
      records
        .flatMap((record) => record.items || [])
        .flatMap((item) => [item[modelLinks.VARIANT_BY_SKU], item[modelLinks.PRODUCT_BY_SKU]])
        .filter(Boolean),
    ),
  ];

  const [variants, productsBySkuResult] = await Promise.all([
    fetchMany(swell, "/products:variants", "sku", skus, ["id", "sku", "parent_id", "name"]),
    fetchMany(swell, "/products", "sku", skus, ["id", "sku"]),
  ]);

  const variantsBySku = keyBy(variants, "sku");
  const parentIds = [
    ...new Set(variants.map((variant: any) => variant.parent_id).filter(Boolean)),
  ];

  const parentProducts = await fetchMany(swell, "/products", "id", parentIds, ["id", "sku"]);

  const productsById = keyBy(parentProducts, "id");
  const productsBySku = keyBy(productsBySkuResult, "sku");

  return {
    resolveItems(items: any[]) {
      const newItems: any[] = [];

      for (const item of items) {
        const variantSku = item[modelLinks.VARIANT_BY_SKU];
        const productSku = item[modelLinks.PRODUCT_BY_SKU];
        const variant = variantSku ? variantsBySku[variantSku] : undefined;
        const product = variant
          ? productsById[variant.parent_id]
          : productSku
            ? productsBySku[productSku]
            : undefined;
        const newItem = { ...item };

        delete newItem[modelLinks.VARIANT_BY_SKU];
        delete newItem[modelLinks.PRODUCT_BY_SKU];

        if (!newItem.product_name && (variantSku || productSku)) {
          newItem.product_name = variantSku || productSku;
        }

        if (variant?.id && variant.parent_id) {
          newItem.product_id = product?.id || variant.parent_id;
          newItem.variant_id = variant.id;
        } else if (product?.id) {
          newItem.product_id = product.id;
        }

        newItems.push(newItem);
      }

      return newItems;
    },
  };
}

async function fetchMany(
  swell: SwellAPI,
  collection: string,
  field: string,
  values: string[],
  fields: string[],
): Promise<any[]> {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (uniqueValues.length === 0) {
    return [];
  }

  const chunks = chunk(uniqueValues, LOOKUP_CHUNK_SIZE);
  const pages = await Promise.all(
    chunks.map((part) =>
      swell.get(collection, {
        [field]: { $in: part },
        fields,
        limit: part.length,
      }),
    ),
  );

  return pages.flatMap((page) => page?.results || []);
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}
