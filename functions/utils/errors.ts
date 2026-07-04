/**
 * A record-level failure that should cause a SINGLE import record to be skipped
 * (collected into the file's `ignored_records`) rather than failing the whole
 * page and triggering a retry.
 *
 * Replaces the old app's three hand-rolled factories
 * (`createSwellError` / `createImageError` / `createFlexiportError`) and the
 * brittle `error.name === "SwellError" || "ImageError"` string checks. Record
 * handlers now `throw new SkippableRecordError(...)` and the page processor
 * decides via `instanceof` — a missing import is a compile error, not a silent
 * `ReferenceError` that escalates a single bad row into a failed import (the
 * customer-path bug, B1).
 *
 * Anything that is NOT a SkippableRecordError (network blip, platform 5xx, bug)
 * propagates so the page can be retried.
 */
export class SkippableRecordError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "SkippableRecordError";
    this.details = details;
  }
}

/**
 * Maps an upstream HTTP status to a merchant-facing message shown on the import
 * record when a FlexiPort API call fails.
 */
export function getUserFriendlyError(err: unknown): string {
  const statusCode = extractStatus(err) ?? 500;

  switch (statusCode) {
    case 400:
      return "Invalid request parameters";
    case 401:
      return "Invalid access key or authorization token";
    case 403:
      return "You don't have permission to perform this operation";
    case 404:
      return "The requested data was not found";
    case 429:
      return "API rate limit exceeded. Please try again later";
    case 500:
      return "Server encountered an internal error";
    case 502:
      return "Bad gateway error while connecting to the service";
    case 503:
      return "Service is temporarily unavailable";
    case 504:
      return "Request timed out while connecting to the service";
    default:
      return `API communication error (Status: ${statusCode})`;
  }
}

/**
 * Whether an upstream FlexiPort error is permanent (no point retrying): bad
 * request, auth, forbidden, or not-found. Everything else (429/5xx, network) is
 * treated as transient so the platform re-delivers the event and we retry.
 */
export function isPermanentError(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }

  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };

  return e.status ?? e.statusCode ?? e.response?.status;
}
