/**
 * Transforms an array of objects into an object keyed by the specified prop.
 * Later entries win on duplicate keys.
 */
export function keyBy<T = any>(array: T[], prop: string): Record<string, T> {
  const result: Record<string, T> = {};

  for (const item of array) {
    result[String((item as any)[prop])] = item;
  }

  return result;
}

/**
 * Converts a string to an underscored, lowercase format
 * (e.g. "Shoe Size" -> "shoe_size"). Used to normalize attribute keys.
 */
export function underscore(str: string | null | undefined): string {
  if (!str) return "";

  return (
    String(str)
      // Convert to lowercase
      .toLowerCase()
      // Replace spaces, dashes, and other non-alphanumeric characters (except underscores) with underscores
      .replace(/[^a-z0-9_]+/g, "_")
      // Remove leading and trailing underscores
      .replace(/^_+|_+$/g, "")
      // Collapse multiple consecutive underscores into one
      .replace(/_+/g, "_")
  );
}
