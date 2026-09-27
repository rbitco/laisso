import { isMap, type Document } from "yaml";
import { isPlainObject } from "./fields.ts";

/**
 * Apply a patch to a YAML document in place, so the comments and the
 * ordering of everything the patch does not touch survive the round trip.
 * A nested mapping recurses, null deletes the key, and any other value is
 * set; a mapping left empty by its deletions is removed with them. A nested
 * mapping is merged, never replaced: to reshape one, clear it with null and
 * set the new keys in a second patch.
 */
export function applyPatch(doc: Document, patch: Record<string, unknown>, path: Array<string | number> = []): void {
  for (const [key, value] of Object.entries(patch)) {
    const at = [...path, key];
    if (value === null) {
      doc.deleteIn(at);
    } else if (isPlainObject(value)) {
      applyPatch(doc, value, at);
      const node = doc.getIn(at, true);
      if (isMap(node) && node.items.length === 0) doc.deleteIn(at);
    } else {
      doc.setIn(at, value);
    }
  }
}

