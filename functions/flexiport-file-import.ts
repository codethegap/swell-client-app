import {
  systemStatuses,
  fileStatuses,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_MAP,
  type ModelSlug,
} from "./constants";
import { createFlexiportClientFor, type FlexiportClient } from "./libs/flexiport";
import { markImportError } from "./utils/import-status";
import { processAttributes } from "./utils/attribute";
import type { IgnoredRecord } from "./utils/batch";
import {
  processExportData,
  fetchFlexiport,
  modelsWithAttributes,
} from "./utils/process-export";
import {
  persistIgnoredRecords,
  sumIgnoredCounts,
} from "./utils/ignored-records";

export const config: SwellConfig = {
  kind: "workflow",
  description: "Import one FlexiPort file, one durable page-step at a time",
};

// Each page-step does one bounded round-trip of IO and may re-run on engine
// restart; a few backed-off retries absorb transient API/rate-limit failures.
const STEP_OPTS: SwellWorkflowStepOptions = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
};

/**
 * Durable per-file importer. The event sequencer (import-updated) starts one
 * instance per file in priority order; this walks that file page by page. The
 * heavy lifting (parse/map/write per entity) is the same code the legacy
 * function used — see functions/utils/process-export.ts — reached through a
 * request-shaped adapter because those handlers only use `swell`/`appValues`.
 */
export default class FlexiportFileImport {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep): Promise<void> {
    const { fileId, claimToken } = (req.data ?? {}) as {
      fileId?: string;
      claimToken?: string;
    };
    if (!fileId || !claimToken) return;

    // The domain handlers expect a SwellRequest; the workflow runtime exposes a
    // narrower shape. They touch only `swell` + `appValues`, so a minimal
    // adapter is runtime-safe. `appValues` mirrors SwellRequest.appValues.
    const ir = {
      swell: req.swell,
      appId: req.appId,
      appValues: (values: object) => ({ $app: { [req.appId]: values } }),
      isWorkflow: true,
    } as unknown as SwellRequest;

    // Set once the file is loaded, so the failure handler can mark the import.
    let importId: string | undefined;

    try {
      const loaded = await step.do("load", STEP_OPTS, async () => {
        const file = await ir.swell.get(`/imports:files/${fileId}`, { expand: ["parent"] });
        if (!file?.parent?.id) return null;
        if (file.claim_token !== claimToken || file.status !== fileStatuses.PROCESSING) {
          return null;
        }
        return {
          slug: file.slug as ModelSlug,
          externalId: file.external_id as string,
          importId: file.parent.id as string,
          accessKey: file.parent.access_key as string,
          apiUrl: (file.parent.api_url as string | undefined) ?? undefined,
          startApproved: !!file.parent.start_approved,
          systemStatus: file.parent.system_status as string,
          claimToken: file.claim_token as string,
          pageSize:
            (file.page_size as number | undefined) ||
            PAGE_SIZE_MAP[file.slug as ModelSlug] ||
            DEFAULT_PAGE_SIZE,
          // Resume cursor: the last page this file completed (0 on a fresh run).
          // A paused-then-resumed file starts a new instance that picks up here.
          currentPage: (file.current_page as number | undefined) ?? 0,
        };
      });
      if (!loaded) return;
      importId = loaded.importId;

      // Respect the run/stop switch and any hard halt. The import stays in
      // "processing" for the duration of this file's run, so the only stop
      // signals are the merchant switch (start_approved) and an error halt.
      if (!loaded.startApproved || loaded.systemStatus === systemStatuses.ERROR) return;

      let flexiport: FlexiportClient;
      try {
        flexiport = createFlexiportClientFor(loaded.accessKey, loaded.apiUrl);
      } catch (err) {
        // Malformed access_key / base URL is a permanent config error — halt
        // cleanly (import marked error, file left as-is), no failed instance.
        await step.do("config-error", STEP_OPTS, async () => {
          await markImportError(ir.swell, loaded.importId, (err as Error).message);
          return {};
        });
        return;
      }

      const pageSize = loaded.pageSize;

      // Ensure store attributes exist before importing product-shaped records.
      if (modelsWithAttributes.includes(loaded.slug)) {
        await step.do("attributes", STEP_OPTS, async () => {
          const attributeData = await fetchFlexiport(ir.swell, loaded.importId, () =>
            flexiport.fetchProductAttributes(loaded.externalId),
          );
          await processAttributes(ir.swell, { attributeData });
          return {};
        });
      }

      // Resume after the last completed page (page 1 on a fresh run). Every write
      // is idempotent, so re-running a page is safe; the cursor just avoids
      // redoing already-finished pages after a pause.
      let page = loaded.currentPage + 1;
      while (true) {
        const outcome = await step.do(
          `page-${page}`,
          STEP_OPTS,
          async (): Promise<{ stopped: boolean; release: boolean; hasMore: boolean }> => {
            // Re-check the switch each page so "Stop" (or a halt) ends paging.
            const [parent, currentFile] = await Promise.all([
              ir.swell.get(`/imports/${loaded.importId}`, {
                fields: ["start_approved", "system_status"],
              }),
              ir.swell.get(`/imports:files/${fileId}`, {
                fields: ["claim_token", "status"],
              }),
            ]);
            if (
              currentFile?.claim_token !== loaded.claimToken ||
              currentFile?.status !== fileStatuses.PROCESSING
            ) {
              return { stopped: true, release: false, hasMore: false };
            }
            if (!parent?.start_approved || parent.system_status === systemStatuses.ERROR) {
              return {
                stopped: true,
                release: parent?.system_status !== systemStatuses.ERROR,
                hasMore: false,
              };
            }

            const exportData = await fetchFlexiport(ir.swell, loaded.importId, () =>
              flexiport.fetchExportById(loaded.externalId, page, pageSize),
            );

            const { ignoredRecords } = await processExportData(ir, {
              records: exportData.records as any[],
              slug: loaded.slug,
              importId: loaded.importId,
            });

            const isLastPage = !exportData.hasMore;
            const processedCount = isLastPage
              ? exportData.totalRecords
              : Math.min(page * pageSize, exportData.totalRecords);

            await writePageProgress(ir.swell, fileId, {
              page,
              importId: loaded.importId,
              total: exportData.totalRecords,
              processedCount,
              ignoredRecords,
            });

            return { stopped: false, release: false, hasMore: exportData.hasMore };
          },
        );

        if (outcome.stopped) {
          // Paused or halted. On a merchant pause, release the file and import
          // back to "pending" so re-approval re-queues this file — the next
          // instance resumes from current_page (written per page below). On an
          // error halt, leave state as-is for the re-sync recovery path
          // (import-created), which rebuilds the file list from scratch.
          if (!outcome.release) return;
          await step.do("release", STEP_OPTS, async () => {
            const parent = await ir.swell.get(`/imports/${loaded.importId}`, {
              fields: ["system_status"],
            });
            const currentFile = await ir.swell.get(`/imports:files/${fileId}`, {
              fields: ["claim_token", "status"],
            });
            if (
              parent?.system_status !== systemStatuses.ERROR &&
              currentFile?.claim_token === loaded.claimToken
            ) {
              await ir.swell.put(`/imports:files/${fileId}`, {
                $set: {
                  status: fileStatuses.PENDING,
                  claim_token: null,
                  claim_started_at: null,
                  workflow_id: null,
                  workflow_started_at: null,
                },
                $events: false,
              });
              await ir.swell.put(`/imports/${loaded.importId}`, {
                $set: { system_status: systemStatuses.PENDING },
                $events: false,
              });
            }
            return {};
          });
          return;
        }
        if (!outcome.hasMore) break;
        page += 1;
      }

      // Complete the file, then flip the import from "processing" back to
      // "pending". Split into two durable steps so a retry after the file write
      // cannot lose state before advancing the parent queue.
      const shouldAdvance = await step.do("finish-file", STEP_OPTS, async () => {
        const currentFile = await ir.swell.get(`/imports:files/${fileId}`, {
          fields: ["claim_token", "status"],
        });
        if (currentFile?.claim_token !== loaded.claimToken) {
          return false;
        }

        await ir.swell.put(`/imports:files/${fileId}`, {
          $set: {
            status: fileStatuses.COMPLETED,
            date_completed: new Date().toISOString(),
            claim_token: null,
            claim_started_at: null,
            ignored_pages: {},
            ignored_page_counts: {},
          },
        });
        return true;
      });

      if (!shouldAdvance) return;

      await step.do("advance-import", STEP_OPTS, async () => {
        await ir.swell.put(`/imports/${loaded.importId}`, {
          system_status: systemStatuses.PENDING,
        });
        return {};
      });
    } catch (err) {
      // A step exhausted its retries (or an unexpected throw). Drive the file
      // and import terminal so the failure is operator-visible and the queue is
      // not wedged behind a file stuck in "processing". Then re-raise so the
      // engine records the workflow instance as failed.
      const message = err instanceof Error ? err.message : String(err);
      const ownsFile = await step.do("mark-file-failed", STEP_OPTS, async () => {
        const currentFile = await ir.swell.get(`/imports:files/${fileId}`, {
          fields: ["claim_token", "status"],
        });
        if (currentFile?.claim_token !== claimToken) {
          return false;
        }

        await ir.swell.put(`/imports:files/${fileId}`, {
          $set: {
            status: fileStatuses.FAILED,
            error_message: message,
            claim_token: null,
            claim_started_at: null,
            ignored_pages: {},
            ignored_page_counts: {},
          },
        });
        return true;
      });
      if (ownsFile) {
        await step.do("mark-import-failed", STEP_OPTS, async () => {
          if (importId) {
            await markImportError(ir.swell, importId, message);
          }
          return {};
        });
      }
      throw err;
    }
  }
}

/**
 * Writes one page's progress with absolute counters. Ignored-record details are
 * persisted separately by deterministic id; the file stores only per-page
 * counts plus the aggregate count, so bad rows cannot grow the parent record
 * without bound. No `$events` needed — nothing subscribes to file events.
 */
async function writePageProgress(
  swell: SwellAPI,
  fileId: string,
  {
    page,
    importId,
    total,
    processedCount,
    ignoredRecords,
  }: {
    page: number;
    importId: string;
    total: number;
    processedCount: number;
    ignoredRecords: IgnoredRecord[];
  },
): Promise<void> {
  await persistIgnoredRecords(swell, { importId, fileId, page, records: ignoredRecords });

  const file = await swell.get(`/imports:files/${fileId}`, {
    fields: ["ignored_page_counts"],
  });
  const counts = {
    ...((file?.ignored_page_counts as Record<string, unknown> | undefined) ?? {}),
    [String(page)]: ignoredRecords.length,
  };

  const set: Record<string, unknown> = {
    processed_records_count: processedCount,
    current_page: page,
    ignored_records_count: sumIgnoredCounts(counts),
    [`ignored_page_counts.${page}`]: ignoredRecords.length,
  };
  if (page === 1) set.total_records_count = total;

  await swell.put(`/imports:files/${fileId}`, { $set: set });
}
