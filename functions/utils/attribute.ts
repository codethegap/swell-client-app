import { keyBy } from "./index";
import { runBatch } from "./batch";

interface AttributeGroup {
  type: string;
  values: string[];
  needsValues: boolean;
}

const VALUE_TYPES = ["select", "checkbox", "radio"];

/**
 * Ensures the store's global product attributes (and their option values) exist
 * before importing the products that reference them. Distinct from record
 * import: this reconciles the shared `/attributes` config, so writes go through
 * normal validation (no `$migrate`).
 */
export async function processAttributes(
  swell: SwellAPI,
  { attributeData }: { attributeData: any[] },
): Promise<void> {
  if (!Array.isArray(attributeData) || attributeData.length === 0) {
    return;
  }

  const attributeGroups: Record<string, AttributeGroup> = {};

  for (const attr of attributeData) {
    if (!attr.key) continue;

    const type = attr.type || "select";

    if (!attributeGroups[attr.key]) {
      attributeGroups[attr.key] = {
        type,
        values: [],
        needsValues: VALUE_TYPES.includes(type),
      };
    } else if (attr.type && attributeGroups[attr.key].type !== attr.type) {
      // Prefer types that require values (select/checkbox/radio) over those that don't.
      if (VALUE_TYPES.includes(attr.type) && !VALUE_TYPES.includes(attributeGroups[attr.key].type)) {
        attributeGroups[attr.key].type = attr.type;
        attributeGroups[attr.key].needsValues = true;
      }
    }

    const group = attributeGroups[attr.key];
    if (group.needsValues && attr.value && !group.values.includes(attr.value)) {
      group.values.push(attr.value);
    }
  }

  const existingAttributes = await swell.get("/attributes", { limit: -1 });
  const attributesByName = keyBy(existingAttributes?.results || [], "name");

  const createRequests: Array<{ method: string; url: string; data: unknown }> = [];
  const updateRequests: Array<{ method: string; url: string; data: unknown }> = [];

  for (const key in attributeGroups) {
    const group = attributeGroups[key];
    const existingAttr = attributesByName[key];

    if (existingAttr) {
      if (!group.needsValues) continue;

      const existingValues: any[] = existingAttr.values || [];
      const existingValueNames = existingValues.map((v) => (typeof v === "object" ? v.name : v));
      const newValues = group.values.filter((v) => !existingValueNames.includes(v));

      if (newValues.length > 0) {
        updateRequests.push({
          method: "put",
          url: `/attributes/${existingAttr.id}`,
          data: { values: [...existingValues, ...newValues.map((name) => ({ name }))] },
        });
      }
    } else {
      const payload: Record<string, unknown> = {
        name: key,
        visible: true,
        required: false,
        type: group.type,
      };

      if (group.needsValues && group.values.length > 0) {
        payload.values = group.values.map((name) => ({ name }));
      }

      createRequests.push({ method: "post", url: "/attributes", data: payload });
    }
  }

  // runBatch chunks and, on the trial plan's rate-limit weight cap, splits and
  // retries so a wide attribute set isn't dropped as one over-weight batch.
  await runBatch(swell, createRequests);
  await runBatch(swell, updateRequests);
}
