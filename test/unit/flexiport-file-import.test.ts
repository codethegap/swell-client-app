import { describe, expect, it, vi } from "vitest";
import FlexiportFileImport from "../../functions/flexiport-file-import";
import { fileStatuses } from "../../functions/constants";

describe("FlexiportFileImport workflow ownership", () => {
  it("exits after load when the claim token does not match the file owner", async () => {
    const get = vi.fn(async (url: string) => {
      if (url === "/imports:files/file_1") {
        return {
          id: "file_1",
          status: fileStatuses.PROCESSING,
          claim_token: "newer-token",
          parent: {
            id: "import_1",
            access_key: "run_abc",
            start_approved: true,
            system_status: "processing",
          },
        };
      }
      throw new Error(`Unexpected get ${url}`);
    });
    const put = vi.fn();
    const step = {
      do: vi.fn(async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()),
    };

    await new FlexiportFileImport().run(
      {
        data: { fileId: "file_1", claimToken: "old-token" },
        appId: "flexiport_client_app",
        swell: { get, put },
      } as any,
      step as any,
    );

    expect(step.do).toHaveBeenCalledTimes(1);
    expect(step.do).toHaveBeenCalledWith("load", expect.any(Object), expect.any(Function));
    expect(put).not.toHaveBeenCalled();
  });
});
