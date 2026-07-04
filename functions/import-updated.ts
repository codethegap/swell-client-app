import { systemStatuses } from "./constants";
import { advanceImportQueue } from "./utils/import-queue";

export const config: SwellConfig = {
  description: "Advance the import file queue: start the next file's import workflow",
  model: {
    events: ["import.updated"],
    conditions: {
      system_status: systemStatuses.PENDING,
      start_approved: true,
    },
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  // import.updated can deliver a partial payload (only the changed fields). With
  // no id there is no import to advance — bail rather than acting on it (which
  // previously produced a `PUT /imports/undefined`).
  if (!data.id) {
    return;
  }

  await advanceImportQueue(swell, data.id);
}
