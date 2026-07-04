import { runBatch, type BatchOp, type IgnoredRecord } from "./batch";
import { stableId } from "./stable-id";

const MAX_DETAILS_CHARS = 4000;

export interface PersistIgnoredRecordsInput {
  importId: string;
  fileId: string;
  page: number;
  records: IgnoredRecord[];
}

export async function persistIgnoredRecords(
  swell: SwellAPI,
  { importId, fileId, page, records }: PersistIgnoredRecordsInput,
): Promise<void> {
  if (records.length === 0) return;

  const ops: BatchOp[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const sourceKey = `${page}:${index}:${record.slug || ""}:${record.name || ""}:${record.error}`;
    const id = await stableId("ignored-record", fileId, sourceKey);

    ops.push({
      method: "put",
      url: `/ignored-records/${id}`,
      data: {
        id,
        import_id: importId,
        file_id: fileId,
        page,
        source_key: sourceKey,
        name: record.name,
        slug: record.slug,
        error: record.error,
        ...(record.details === undefined ? {} : { details: stringifyDetails(record.details) }),
      },
    });
  }

  const results = await runBatch(swell, ops);
  const failed = results.find((result) => result && typeof result === "object" && "$error" in result);
  if (failed && typeof failed === "object" && "$error" in failed) {
    throw new Error(`Failed to persist ignored record: ${String(failed.$error)}`);
  }
}

export function sumIgnoredCounts(counts: Record<string, unknown>): number {
  return Object.values(counts).reduce<number>((total, value) => {
    const n = Number(value);
    return Number.isFinite(n) ? total + n : total;
  }, 0);
}

function stringifyDetails(details: unknown): string {
  let value: string;
  try {
    value = typeof details === "string" ? details : JSON.stringify(details);
  } catch {
    value = String(details);
  }
  return value.length > MAX_DETAILS_CHARS ? `${value.slice(0, MAX_DETAILS_CHARS)}...` : value;
}
