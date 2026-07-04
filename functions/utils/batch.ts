import { SkippableRecordError } from "./errors";

export interface IgnoredRecord {
  name?: string;
  slug?: string;
  error: string;
  details?: unknown;
}

export interface ImportRecord {
  name?: string;
  slug?: string;
  [key: string]: unknown;
}

export interface BulkUpsertOptions<T extends ImportRecord> {
  records: T[];
  /** Collection base path, e.g. "/products", "/accounts", "/categories:products". */
  collection: string;
  /**
   * Natural key for the idempotent upsert (slug / sku / email / order number).
   * Return a falsy value to POST instead (non-idempotent — re-runs may duplicate).
   */
  keyOf: (record: T, data: Record<string, unknown>) => string | null | undefined;
  /**
   * Builds the write payload for one record. May do I/O (image rehost, link
   * resolution). Throw SkippableRecordError to drop a single record into
   * `ignored_records`; any other throw aborts the page so it can be retried.
   */
  buildData: (record: T) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** App-scoped fields merged into every write, e.g. req.appValues({ import_id }). */
  appData?: Record<string, unknown>;
  /**
   * Use Swell's migration write path. This suppresses side effects and should
   * be reserved for historical orders or other imports where validation and
   * model side effects must intentionally be bypassed.
   */
  migrate?: boolean;
}

export interface BatchOp {
  method: string;
  url: string;
  data?: unknown;
}

// Swell's documented ceiling for a single /:batch call.
const BATCH_LIMIT = 1000;

/**
 * Imports records via a single idempotent, validation-skipping bulk write:
 *
 *   - PUT /{collection}/{naturalKey} for create-or-update, so retries and
 *     re-runs never duplicate records with natural keys,
 *   - grouped into `/:batch` calls of up to 1000 ops (partial success),
 *   - per-op `$error`s mapped back to the originating record as ignored.
 *
 * Replaces the old one-POST-per-record loop (the reason page size was pinned at
 * 2) and its duplicate-on-retry behavior.
 */
export async function bulkUpsert<T extends ImportRecord>(
  swell: SwellAPI,
  { records, collection, keyOf, buildData, appData, migrate = false }: BulkUpsertOptions<T>,
): Promise<{ ignoredRecords: IgnoredRecord[] }> {
  const ignoredRecords: IgnoredRecord[] = [];
  const ops: BatchOp[] = [];
  const sources: T[] = [];

  for (const record of records) {
    try {
      const data = await buildData(record);
      const key = keyOf(record, data);
      const url = key ? `${collection}/${encodeURIComponent(key)}` : collection;

      ops.push({
        method: key ? "put" : "post",
        url,
        data: { ...(migrate ? { $migrate: true } : {}), ...data, ...appData },
      });
      sources.push(record);
    } catch (err) {
      if (err instanceof SkippableRecordError) {
        ignoredRecords.push({
          name: record.name,
          slug: record.slug,
          error: err.message,
          details: err.details,
        });
      } else {
        throw err; // unexpected — let the page retry
      }
    }
  }

  const results = await runBatch(swell, ops);
  results.forEach((result, i) => {
    if (result && typeof result === "object" && "$error" in result) {
      const source = sources[i];
      ignoredRecords.push({
        name: source.name,
        slug: source.slug,
        error: String((result as { $error: unknown }).$error),
      });
    }
  });

  return { ignoredRecords };
}

/**
 * Posts a list of ops to `/:batch`, chunked to `maxChunk`, returning a flat
 * array of per-op results aligned to `ops` (index i -> result for ops[i]). Each
 * chunk goes through {@link postBatchOps}, which transparently splits and
 * retries when the platform rate limiter drops an over-weight batch.
 */
export async function runBatch(
  swell: SwellAPI,
  ops: BatchOp[],
  maxChunk = BATCH_LIMIT,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; offset < ops.length; offset += maxChunk) {
    const part = await postBatchOps(swell, ops.slice(offset, offset + maxChunk));
    out.push(...part);
  }
  return out;
}

/**
 * Posts ops to `/:batch`. The platform rate limiter assigns each `/:batch` a
 * weight equal to the SUM of its child op weights (1 per simple write) and
 * drops — before executing any op — a batch whose weight exceeds the plan's max
 * concurrency (only 2 on the trial/low-concurrency plan), surfacing
 * `ERR OVERWEIGHT:<weight>:<max>`. Because the drop happens pre-execution, no op
 * runs, so halve-and-retry is safe (never double-writes). Higher plans cap
 * weight at 5 (<= their max of 10), so this never splits in production.
 * Returns per-op results aligned to `ops`.
 */
export async function postBatchOps(swell: SwellAPI, ops: BatchOp[]): Promise<unknown[]> {
  if (ops.length === 0) {
    return [];
  }

  try {
    const results = (await swell.post("/:batch", ops)) as Record<string, unknown> | undefined;
    return ops.map((_op, i) => results?.[String(i)]);
  } catch (err) {
    if (ops.length > 1 && isRateLimitWeightError(err)) {
      const mid = Math.ceil(ops.length / 2);
      const head = await postBatchOps(swell, ops.slice(0, mid));
      const tail = await postBatchOps(swell, ops.slice(mid));
      return [...head, ...tail];
    }
    throw err; // size-1 or a non-rate-limit error — surface it
  }
}

/**
 * Detects the rate limiter's over-weight rejection
 * (`ERR OVERWEIGHT:<weight>:<max>` / "max weight exceeded"), which reaches the
 * function as a SwellError whose body carries the upstream message.
 */
export function isRateLimitWeightError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { message?: unknown; body?: unknown };
  let body = "";
  try {
    body = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
  } catch {
    body = "";
  }
  return /overweight|max weight/i.test(`${String(e.message ?? "")} ${body}`);
}
