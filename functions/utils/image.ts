import { SkippableRecordError } from "./errors";
import { stableId } from "./stable-id";

export interface UploadedFile {
  id: string;
  url: string;
  length?: number;
  md5?: string;
  content_type?: string;
  filename?: string;
}

interface SourceImage {
  caption?: string;
  alt?: string;
  file?: { url?: string | null };
}

/**
 * Converts an ArrayBuffer to a base64 string.
 *
 * NOTE: holds the whole image in memory and inflates ~33%. Bounded in practice
 * by the small per-invocation page size and the upload concurrency limit. If
 * very large source images ever cause Worker memory pressure, stream/chunk here.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;

  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

/**
 * Downloads an image from a URL and REHOSTS it on Swell (base64 upload), so the
 * migrated store no longer depends on the source platform's URLs. Returns the
 * Swell file `{ id, url }`.
 *
 * Throws SkippableRecordError on fetch failure / non-image content; callers that
 * upload many images catch this per-image so one bad image never fails a record.
 */
export async function loadImage(swell: SwellAPI, url: string): Promise<UploadedFile> {
  const cached = await readCachedImage(swell, url);
  if (cached) return cached;

  const response = await fetch(url);

  if (!response.ok) {
    throw new SkippableRecordError(
      `Failed to fetch image: ${response.status} ${response.statusText}`,
      { url, status: response.status, statusText: response.statusText },
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type");

  if (!mimeType || !mimeType.startsWith("image/")) {
    throw new SkippableRecordError(`Unsupported MIME type: ${mimeType}`, { url, mimeType });
  }

  const file = await swell.post("/:files", {
    content_type: mimeType,
    filename: filenameFromUrl(url, mimeType),
    data: { $base64: arrayBufferToBase64(arrayBuffer) },
  });

  await writeCachedImage(swell, url, file, mimeType);

  return file;
}

export function isSwellCdnUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https:\/\/cdn\.swell\.store\//i.test(url);
}

export function toFileObject(file: UploadedFile): UploadedFile {
  return {
    id: file.id,
    url: file.url,
    ...(typeof file.length === "number" ? { length: file.length } : {}),
    ...(file.md5 ? { md5: file.md5 } : {}),
    ...(file.content_type ? { content_type: file.content_type } : {}),
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

async function readCachedImage(swell: SwellAPI, sourceUrl: string): Promise<UploadedFile | null> {
  try {
    const id = await stableId("image-cache", sourceUrl);
    const cached = await swell.get(`/image-cache/${id}`);
    if (cached?.file_id && cached?.file_url) {
      return {
        id: cached.file_id,
        url: cached.file_url,
        ...(typeof cached.length === "number" ? { length: cached.length } : {}),
        ...(cached.md5 ? { md5: cached.md5 } : {}),
        ...(cached.content_type ? { content_type: cached.content_type } : {}),
        ...(cached.filename ? { filename: cached.filename } : {}),
      };
    }
  } catch {
    // Cache misses and cache read failures should not block the import.
  }

  return null;
}

async function writeCachedImage(
  swell: SwellAPI,
  sourceUrl: string,
  file: UploadedFile,
  contentType: string,
): Promise<void> {
  try {
    const id = await stableId("image-cache", sourceUrl);
    await swell.put(`/image-cache/${id}`, {
      id,
      source_url: sourceUrl,
      file_id: file.id,
      file_url: file.url,
      content_type: contentType,
      length: file.length,
      md5: file.md5,
      filename: file.filename,
    });
  } catch {
    // The product write remains correct without the cache; a retry may rehost.
  }
}

/**
 * FlexiPort sometimes packs several image URLs into one comma-separated field.
 * Returns the first URL, splitting ONLY at a comma that begins a new absolute
 * URL — commas inside a single signed/CDN URL are preserved (fixes B4, where a
 * naive split on "," truncated valid URLs that contain commas).
 */
export function getFirstUrl(value: string | null | undefined): string {
  if (!value || typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  const parts = trimmed.split(/,(?=\s*https?:\/\/)/);

  return parts[0].trim();
}

/**
 * Uploads (rehosts) a list of source images on Swell with a concurrency limit.
 * A single image that fails to upload is dropped, not fatal to the record.
 */
export async function uploadImages(
  swell: SwellAPI,
  images: SourceImage[] | undefined,
  concurrencyLimit = 5,
): Promise<Array<{ caption: string; file: UploadedFile }>> {
  const uploaded: Array<{ caption: string; file: UploadedFile }> = [];

  if (!Array.isArray(images) || images.length === 0) {
    return uploaded;
  }

  const valid = images.filter((image) => image?.file?.url && image.file.url !== "None");
  if (valid.length === 0) {
    return uploaded;
  }

  for (let i = 0; i < valid.length; i += concurrencyLimit) {
    const batch = valid.slice(i, i + concurrencyLimit);

    const results = await Promise.all(
      batch.map(async (image) => {
        try {
          const file = await loadImage(swell, getFirstUrl(image.file!.url));
          return { caption: image.caption || "", file: toFileObject(file) };
        } catch {
          return null; // drop a single bad image; keep the record
        }
      }),
    );

    for (const result of results) {
      if (result) uploaded.push(result);
    }
  }

  return uploaded;
}

function filenameFromUrl(url: string, mimeType: string): string {
  let base = "image";
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    base = pathname.split("/").filter(Boolean).pop() || base;
  } catch {
    base = url.split(/[/?#]/)[0] || base;
  }

  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const filename = sanitized || "image";

  if (/\.[a-z0-9]{2,5}$/i.test(filename)) {
    return filename;
  }

  return `${filename}${extensionForMime(mimeType)}`;
}

function extensionForMime(mimeType: string): string {
  if (/png/i.test(mimeType)) return ".png";
  if (/webp/i.test(mimeType)) return ".webp";
  if (/gif/i.test(mimeType)) return ".gif";
  if (/svg/i.test(mimeType)) return ".svg";
  return ".jpg";
}
