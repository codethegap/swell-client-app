import { systemStatuses, resolveModelSlug, SLUG_PRIORITY } from "./constants";
import {
  createFlexiportClientFor,
  type FlexiportClient,
  type FlexiportExport,
} from "./libs/flexiport";
import { getUserFriendlyError, isPermanentError } from "./utils/errors";
import { markImportError } from "./utils/import-status";

export const config: SwellConfig = {
  description: "Sync FlexiPort export manifest into import files",
  model: {
    events: ["import.created", "import.updated"],
    conditions: {
      system_status: { $in: [systemStatuses.SYNCING, systemStatuses.ERROR] },
      start_approved: false,
      access_key: { $exists: true },
    },
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  // import.updated can deliver a partial payload (only the changed fields). With
  // no id/access_key there is nothing to sync — bail rather than acting on a
  // half-populated record (which previously produced a `PUT /imports/undefined`).
  if (!data.id || !data.access_key) {
    return;
  }

  let flexiport: FlexiportClient;
  try {
    flexiport = createFlexiportClientFor(data.access_key, data.api_url);
  } catch (err) {
    // Malformed access_key / base URL is a permanent config error — halt the
    // import and surface the message rather than retrying forever.
    await markImportError(swell, data.id, (err as Error).message);
    return;
  }

  let exports: FlexiportExport[];
  try {
    exports = await flexiport.fetchExports();
  } catch (err) {
    if (isPermanentError(err)) {
      await markImportError(swell, data.id, getUserFriendlyError(err));
      return;
    }
    throw err; // transient — let the platform re-deliver and retry
  }

  if (!exports?.length) {
    // Pipeline likely hasn't finished; surface it and let the merchant re-save
    // to retry (re-saving re-fires this function via import.updated).
    await markImportError(
      swell,
      data.id,
      "No data found for import, the pipeline may not have finished running yet.",
    );
    return;
  }

  // Map each export to an import file, resolving its model slug. Exports we
  // don't recognize are skipped (logged) rather than failing the whole sync.
  const files = exports.flatMap((exp) => {
    const slug = resolveModelSlug(exp);
    if (!slug) {
      console.warn(
        `Skipping unrecognized export: id=${exp.id} table=${exp.table} slug=${exp.slug} name=${exp.name} description=${exp.description}`,
      );
      return [];
    }
    return [
      {
        external_id: exp.id,
        name: exp.name || exp.id,
        description: exp.description,
        slug,
        priority: exp.priority ?? SLUG_PRIORITY[slug] ?? 0,
        status: "pending",
        current_page: 0,
        page_size: null,
        processed_records_count: 0,
        total_records_count: 0,
        ignored_records_count: 0,
        ignored_records: [],
        ignored_pages: {},
        ignored_page_counts: {},
        error_message: null,
        claim_token: null,
        claim_started_at: null,
        workflow_id: null,
        workflow_started_at: null,
        date_completed: null,
      },
    ];
  });

  if (files.length === 0) {
    await markImportError(swell, data.id, "No recognizable data found for import.");
    return;
  }

  const { pipeline_id, pipeline_run_id } = exports[0];

  await swell.put(`/imports/${data.id}`, {
    $set: {
      ...(pipeline_run_id ? { run_id: pipeline_run_id } : {}),
      ...(pipeline_id ? { external_pipeline_id: pipeline_id } : {}),
      files,
      files_count: files.length,
      system_status: systemStatuses.PENDING,
      error_message: null,
      date_completed: null,
      image_rehost_product_page: 1,
      image_rehost_category_page: 1,
      image_rehost_processed_count: 0,
      image_rehost_error_count: 0,
      image_rehost_products_completed: false,
      image_rehost_categories_completed: false,
      date_images_completed: null,
    },
    $events: false,
  });
}
