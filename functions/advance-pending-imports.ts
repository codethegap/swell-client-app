import { systemStatuses } from "./constants";
import { advanceImportQueue } from "./utils/import-queue";

export const config: SwellConfig = {
  description: "Advance approved pending imports that were handed off by workflows",
  cron: { schedule: "* * * * *" },
};

export default async function (req: SwellRequest) {
  const limit = 50;
  let page = 1;

  while (true) {
    const result = await req.swell.get("/imports", {
      system_status: systemStatuses.PENDING,
      fields: ["id", "start_approved"],
      limit,
      page,
    });
    const imports = Array.isArray(result?.results) ? result.results : [];

    for (const record of imports) {
      if (!record?.id) continue;
      if (record.start_approved !== true) continue;
      await advanceImportQueue(req.swell, record.id);
    }

    const pageCount = Number(result?.page_count ?? 0);
    if (imports.length < limit || pageCount <= page) break;
    page += 1;
  }
}
