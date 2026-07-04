import { systemStatuses } from "../constants";

/**
 * Marks an import as failed and halts it (`start_approved: false`), with a
 * merchant-facing message. Uses `$events: false` so it does not re-trigger the
 * sync/queue functions.
 */
export function markImportError(
  swell: SwellAPI,
  importId: string,
  message: string,
): Promise<unknown> {
  return swell.put(`/imports/${importId}`, {
    start_approved: false,
    system_status: systemStatuses.ERROR,
    error_message: message,
    $events: false,
  });
}
