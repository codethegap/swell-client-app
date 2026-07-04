import { bulkUpsert, type IgnoredRecord } from "./batch";

/**
 * Imports customer accounts, idempotently keyed by `email`.
 *
 * Customer records are written through Swell's normal account path rather than
 * `$migrate`: accounts without `password` do not trigger the welcome email, and
 * normal writes preserve validation plus default address bookkeeping.
 *
 * (The old implementation called `createSwellError` here without importing it —
 * a `ReferenceError` that escalated any single bad account into a failed import,
 * bug B1. That whole class is gone: validation errors now surface as per-op
 * `$error`s mapped to `ignored_records` by the batch helper.)
 */
export async function createCustomers(
  req: SwellRequest,
  { records, importId }: { records: any[]; importId: string },
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const { swell } = req;

  return bulkUpsert(swell, {
    records,
    collection: "/accounts",
    keyOf: (record) => record.email,
    appData: req.appValues({ import_id: importId }),
    buildData: (record) => ({ ...record }),
  });
}
