import { rehostImportImages } from "./utils/rehost-images";

export const config: SwellConfig = {
  description: "Upload imported product/category images to Swell CDN outside workflow runtime",
  cron: { schedule: "* * * * *" },
};

const DEFAULT_IMAGE_LIMIT = 5;
const FLEXIPORT_INSTALLED_APP_ID = "6a453267354fa30012344fe5";

export default async function (req: SwellRequest) {
  const importId = req.data?.import_id || req.data?.importId;
  const maxImages = Number(req.data?.limit || DEFAULT_IMAGE_LIMIT);
  const appId = appQueryId(req);

  if (importId) {
    return rehostImportImages(req.swell, {
      importId,
      appId,
      maxImages,
    });
  }

  const result = await req.swell.get("/imports", {
    fields: [
      "id",
      "date_images_completed",
      "start_approved",
      "system_status",
      "image_rehost_products_completed",
      "image_rehost_categories_completed",
    ],
    limit: 25,
    sort: "date_created desc",
  });
  const imports = Array.isArray(result?.results) ? result.results : [];

  for (const record of imports) {
    if (!record?.id || record.date_images_completed) continue;
    if (record.start_approved !== true && record.system_status !== "completed") continue;
    await rehostImportImages(req.swell, {
      importId: record.id,
      appId,
      maxImages,
    });
    return;
  }
}

function appQueryId(req: SwellRequest): string {
  const context = req.context as any;
  const candidates = [
    context?.installedAppId,
    context?.installed_app_id,
    context?.app?.id,
    req.appId,
  ];
  return candidates.find(isObjectIdLike) || FLEXIPORT_INSTALLED_APP_ID;
}

function isObjectIdLike(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
}
