import { isMap, isNode, isScalar, type Document, type ToStringOptions } from "yaml";
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
      keepHeader(doc, at);
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

/**
 * A comment at the top of a file with no blank line under it belongs to the
 * first key as far as the parser is concerned, so deleting that key would
 * take the file's header with it: hand it to the document instead.
 */
function keepHeader(doc: Document, at: Array<string | number>): void {
  if (at.length !== 1 || !isMap(doc.contents)) return;
  const [first, next] = doc.contents.items;
  if (!first || !isScalar(first.key) || first.key.value !== at[0] || !first.key.commentBefore) return;
  doc.commentBefore = doc.commentBefore ? doc.commentBefore + "\n" + first.key.commentBefore : first.key.commentBefore;
  // The document comment brings its own blank line.
  if (next && isNode(next.key)) next.key.spaceBefore = false;
}

/**
 * Keep what an edit does not touch as it was: no line folding, and [flow]
 * collections padded as the file already pads them, since the writer
 * applies one choice to every one of them.
 */
export function writeLike(text: string): ToStringOptions {
  return { lineWidth: 0, flowCollectionPadding: /[{[] +[^\s}\]]/.test(text) };
}
