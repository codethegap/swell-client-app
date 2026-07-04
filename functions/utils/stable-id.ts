/**
 * Derives a deterministic 24-hex ObjectId-compatible id from string parts.
 * Retried writes for the same logical item use the same id.
 */
export async function stableId(...parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join(":"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

export function createClaimToken(fileId: string): string {
  const random =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");

  return `${fileId}:${Date.now()}:${random}`;
}
