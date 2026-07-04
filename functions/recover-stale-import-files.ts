import { fileStatuses, systemStatuses } from "./constants";

export const config: SwellConfig = {
  description: "Recover import files claimed before a workflow was recorded",
  cron: { schedule: "*/15 * * * *" },
};

const STALE_CLAIM_MS = 15 * 60 * 1000;

export default async function (req: SwellRequest) {
  const cutoff = Date.now() - STALE_CLAIM_MS;
  const limit = 100;
  let page = 1;

  while (true) {
    const result = await req.swell.get("/imports:files", {
      status: fileStatuses.PROCESSING,
      fields: [
        "id",
        "parent_id",
        "claim_token",
        "claim_started_at",
        "workflow_id",
        "current_page",
      ],
      limit,
      page,
    });
    const files = Array.isArray(result?.results) ? result.results : [];

    for (const file of files) {
      if (!isRecoverableStaleClaim(file, cutoff)) continue;

      await req.swell.put(`/imports:files/${file.id}`, {
        $set: {
          status: fileStatuses.PENDING,
          claim_token: null,
          claim_started_at: null,
          workflow_id: null,
          workflow_started_at: null,
        },
        $events: false,
      });

      if (file.parent_id) {
        await req.swell.put(`/imports/${file.parent_id}`, {
          $set: { system_status: systemStatuses.PENDING },
          $events: false,
        });
      }
    }

    const pageCount = Number(result?.page_count ?? 0);
    if (files.length < limit || pageCount <= page) break;
    page += 1;
  }
}

function isRecoverableStaleClaim(file: any, cutoff: number): boolean {
  if (file.workflow_id) return false;
  if (Number(file.current_page ?? 0) > 0) return false;
  if (!file.claim_started_at) return false;

  const claimedAt = new Date(file.claim_started_at).getTime();
  return Number.isFinite(claimedAt) && claimedAt < cutoff;
}
