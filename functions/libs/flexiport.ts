/**
 * Minimal client for the FlexiPort.ai integrations API.
 *
 * Auth is by `access_key` passed as a query parameter — this is FlexiPort's API
 * contract, not our choice; do not move it to a header without their docs.
 */

export interface FlexiportExport {
  id: string;
  /** Source table, e.g. "mutate_swell_categories" — used to resolve the model slug. */
  table?: string;
  total?: number;
  name?: string;
  description?: string;
  slug?: string;
  priority?: number;
  pipeline_id?: string;
  pipeline_run_id?: string;
}

export interface FlexiportPage {
  records: unknown[];
  hasMore: boolean;
  totalPages: number;
  totalRecords: number;
}

/** Upstream API error carrying the HTTP status for `getUserFriendlyError`. */
export class FlexiportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FlexiportError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FlexiportClient {
  fetchExports(): Promise<FlexiportExport[]>;
  fetchExportById(id: string, page?: number, limit?: number): Promise<FlexiportPage>;
  fetchProductAttributes(id: string): Promise<unknown[]>;
}

export function createFlexiportClient(
  accessKey: string,
  options: { baseUrl?: string } = {},
): FlexiportClient {
  if (!accessKey) {
    throw new Error("Access key is required to create Flexiport API client");
  }

  const baseUrl = options.baseUrl || "https://api.flexiport.ai/integrations/v1";

  async function makeRequest(endpoint: string, reqOptions: RequestOptions = {}): Promise<any> {
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.append("access_key", accessKey);

    if (reqOptions.params) {
      for (const [key, value] of Object.entries(reqOptions.params)) {
        url.searchParams.append(key, String(value));
      }
    }

    const method = reqOptions.method || "GET";
    const fetchOptions: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", ...(reqOptions.headers || {}) },
    };
    if (reqOptions.body && method !== "GET") {
      fetchOptions.body = JSON.stringify(reqOptions.body);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), fetchOptions);
    } catch (err) {
      // Network/transport failure — no HTTP status available.
      throw new FlexiportError(`Request failed: ${(err as Error).message}`, 500);
    }

    if (!response.ok) {
      throw new FlexiportError(`HTTP error! Status: ${response.status}`, response.status);
    }

    return response.json();
  }

  return {
    fetchExports() {
      return makeRequest("/exports");
    },

    async fetchExportById(id, page = 1, limit = 50) {
      const data = await makeRequest(`/exports/${id}`, { params: { page, limit } });

      return {
        records: data.items || [],
        hasMore: data.page < data.pages,
        totalPages: data.pages,
        totalRecords: data.total,
      };
    },

    fetchProductAttributes(id) {
      return makeRequest(`/swell/exports/${id}/attributes`);
    },
  };
}

/** Default API path appended to a base URL that carries only an origin. */
const DEFAULT_API_PATH = "/integrations/v1";

export interface ParsedAccessKey {
  /** Bare access key sent as the `access_key` query param. */
  accessKey: string;
  /** Inline base URL override (normalized); undefined when none was provided. */
  baseUrl?: string;
}

/**
 * Parses an import's `access_key`, which may carry an inline base URL using the
 * `<access_key>@<base_url>` form so a single dashboard box can point a sync at a
 * local or tunnelled pipeline:
 *
 *   "run_abc"                            -> { accessKey: "run_abc" }                          (production default)
 *   "run_abc@http://localhost:3010"      -> { accessKey, baseUrl: "http://localhost:3010/integrations/v1" }
 *   "run_abc@https://x.trycloudflare.com"-> { accessKey, baseUrl: ".../integrations/v1" }
 *
 * We split on the FIRST "@": access keys never contain "@", so this stays
 * unambiguous even if the URL itself has userinfo. When an "@" is present, both
 * sides must be non-empty.
 */
export function parseAccessKey(raw: string): ParsedAccessKey {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error("Access key is required");
  }

  const at = value.indexOf("@");
  if (at === -1) {
    return { accessKey: value };
  }

  const accessKey = value.slice(0, at).trim();
  const urlPart = value.slice(at + 1).trim();
  if (!accessKey) {
    throw new Error('Access key is missing before "@"');
  }
  if (!urlPart) {
    throw new Error('Base URL is missing after "@"');
  }

  return { accessKey, baseUrl: normalizeBaseUrl(urlPart) };
}

/**
 * Normalizes a base URL to `origin + path` (no query/hash, no trailing slash),
 * appending the default integrations path when the URL carries none — so a bare
 * origin like "https://x.trycloudflare.com" still resolves to the API root.
 */
function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid base URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must use http or https: ${input}`);
  }
  const path = parsed.pathname.replace(/\/+$/, "") || DEFAULT_API_PATH;
  return `${parsed.origin}${path}`;
}

/**
 * Builds a client from an import's raw `access_key` (which may inline a base URL
 * via the `@` form) plus an optional explicit `api_url` override that, when set,
 * wins over any inline URL. Throws on a malformed value — callers should treat
 * that as a permanent config error and halt the import.
 */
export function createFlexiportClientFor(
  rawAccessKey: string,
  apiUrlOverride?: string,
): FlexiportClient {
  const { accessKey, baseUrl } = parseAccessKey(rawAccessKey);
  const override = apiUrlOverride?.trim();
  const resolved = override ? normalizeBaseUrl(override) : baseUrl;
  return createFlexiportClient(accessKey, { baseUrl: resolved });
}
