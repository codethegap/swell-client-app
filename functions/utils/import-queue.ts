import { systemStatuses, fileStatuses, DEFAULT_PAGE_SIZE, PAGE_SIZE_MAP } from "../constants";
import { createClaimToken } from "./stable-id";

export async function advanceImportQueue(
  swell: SwellAPI,
  importId: string,
): Promise<void> {
  const files = await listImportFiles(swell, importId);

  if (files.length === 0) {
    await swell.put(`/imports/${importId}`, {
      $set: {
        system_status: systemStatuses.ERROR,
        error_message:
          "No data files for import, the pipeline may not have finished running yet.",
      },
      $events: false,
    });
    return;
  }

  // A workflow still owns a file. Re-delivered events or workflow re-entry
  // should not claim another file while that work is in flight.
  if (files.some((file) => file.status === fileStatuses.PROCESSING)) {
    return;
  }

  const nextFile = files
    .filter((file) => file.status === fileStatuses.PENDING)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))[0];

  if (!nextFile) {
    if (files.every((file) => file.status === fileStatuses.COMPLETED)) {
      await swell.put(`/imports/${importId}`, {
        system_status: systemStatuses.COMPLETED,
        date_completed: new Date().toISOString(),
        $events: false,
      });
    }
    return;
  }

  const claimToken = createClaimToken(nextFile.id);
  const claimedAt = new Date().toISOString();
  const pageSize = nextFile.page_size || PAGE_SIZE_MAP[nextFile.slug] || DEFAULT_PAGE_SIZE;
  await swell.put(`/imports:files/${nextFile.id}`, {
    $set: {
      status: fileStatuses.PROCESSING,
      error_message: null,
      page_size: pageSize,
      claim_token: claimToken,
      claim_started_at: claimedAt,
      workflow_id: null,
      workflow_started_at: null,
    },
    $events: false,
  });
  await swell.put(`/imports/${importId}`, {
    $set: { system_status: systemStatuses.PROCESSING },
    $events: false,
  });

  let run: { id: string };
  try {
    run = await swell.workflows.create("flexiport-file-import", {
      fileId: nextFile.id,
      claimToken,
    });
  } catch (err) {
    await releaseClaimIfCurrent(swell, importId, nextFile.id, claimToken);
    throw err;
  }

  const current = await swell.get(`/imports:files/${nextFile.id}`, {
    fields: ["claim_token", "status"],
  });
  if (current?.claim_token !== claimToken || current?.status !== fileStatuses.PROCESSING) {
    return;
  }

  await swell.put(`/imports:files/${nextFile.id}`, {
    $set: {
      workflow_id: run.id,
      workflow_started_at: new Date().toISOString(),
    },
    $events: false,
  });
}

async function listImportFiles(swell: SwellAPI, importId: string): Promise<any[]> {
  const files: any[] = [];
  const limit = 1000;
  let page = 1;

  while (true) {
    const result = await swell.get("/imports:files", {
      parent_id: importId,
      limit,
      page,
    });
    const results = Array.isArray(result?.results) ? result.results : [];
    files.push(...results);

    const pageCount = Number(result?.page_count ?? 0);
    if (results.length < limit || pageCount <= page) break;
    page += 1;
  }

  return files;
}

async function releaseClaimIfCurrent(
  swell: SwellAPI,
  importId: string,
  fileId: string,
  claimToken: string,
): Promise<void> {
  const current = await swell.get(`/imports:files/${fileId}`, {
    fields: ["claim_token", "status"],
  });
  if (current?.claim_token !== claimToken) return;

  await swell.put(`/imports:files/${fileId}`, {
    $set: {
      status: fileStatuses.PENDING,
      claim_token: null,
      claim_started_at: null,
      workflow_id: null,
      workflow_started_at: null,
    },
    $events: false,
  });
  await swell.put(`/imports/${importId}`, {
    $set: { system_status: systemStatuses.PENDING },
    $events: false,
  });
}
