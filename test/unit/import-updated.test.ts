import { describe, expect, it, vi } from "vitest";
import handler from "../../functions/import-updated";
import { fileStatuses, systemStatuses } from "../../functions/constants";
import { createMockRequest } from "../helpers/mock-request";

describe("import-updated queue advance", () => {
  it("claims a file with a token before creating the workflow and records the run only for the current owner", async () => {
    const file: any = { id: "file_1", status: fileStatuses.PENDING, priority: 0 };
    const parent: any = { id: "import_1", system_status: systemStatuses.PENDING };

    const get = vi.fn(async (url: string) => {
      if (url === "/imports:files") return { results: [{ ...file }], page_count: 1 };
      if (url === "/imports:files/file_1") return { ...file };
      throw new Error(`Unexpected get ${url}`);
    });
    const put = vi.fn(async (url: string, data: any) => {
      if (url === "/imports:files/file_1") {
        Object.assign(file, data.$set ?? data);
        return { ...file };
      }
      if (url === "/imports/import_1") {
        Object.assign(parent, data.$set ?? data);
        return { ...parent };
      }
      throw new Error(`Unexpected put ${url}`);
    });
    const create = vi.fn(async (_name: string, params: any) => {
      expect(params.fileId).toBe("file_1");
      expect(params.claimToken).toBe(file.claim_token);
      return { id: "wf_1" };
    });

    const req = createMockRequest({
      data: { id: "import_1" },
      swell: { get, put, workflows: { create } } as any,
    });

    await handler(req);

    expect(file.status).toBe(fileStatuses.PROCESSING);
    expect(file.claim_token).toEqual(expect.any(String));
    expect(file.workflow_id).toBe("wf_1");
    expect(parent.system_status).toBe(systemStatuses.PROCESSING);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not record workflow_id when another claim wins after workflow creation", async () => {
    const file: any = { id: "file_1", status: fileStatuses.PENDING, priority: 0 };

    const get = vi.fn(async (url: string) => {
      if (url === "/imports:files") return { results: [{ ...file }], page_count: 1 };
      if (url === "/imports:files/file_1") return { ...file };
      return { id: "import_1" };
    });
    const put = vi.fn(async (url: string, data: any) => {
      if (url === "/imports:files/file_1") {
        Object.assign(file, data.$set ?? data);
      }
      return {};
    });
    const create = vi.fn(async () => {
      file.claim_token = "stolen-by-newer-event";
      return { id: "wf_stale" };
    });

    const req = createMockRequest({
      data: { id: "import_1" },
      swell: { get, put, workflows: { create } } as any,
    });

    await handler(req);

    expect(file.workflow_id).toBeNull();
    expect(put).not.toHaveBeenCalledWith(
      "/imports:files/file_1",
      expect.objectContaining({
        $set: expect.objectContaining({ workflow_id: "wf_stale" }),
      }),
    );
  });
});
