/** Atlassian Document Format to plain text: enough for an issue body a Runner can read. */
export function adfToText(node: unknown): string {
  return render(node).replace(/\n{3,}/g, "\n\n").trim();
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

function render(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as AdfNode;
  const children = (n.content ?? []).map(render);
  switch (n.type) {
    case "text": {
      let text = n.text ?? "";
      for (const mark of n.marks ?? []) {
        if (mark.type === "code") text = "`" + text + "`";
        if (mark.type === "strong") text = "**" + text + "**";
        if (mark.type === "em") text = "_" + text + "_";
        if (mark.type === "link" && typeof mark.attrs?.href === "string") text = `[${text}](${mark.attrs.href})`;
      }
      return text;
    }
    case "hardBreak":
      return "\n";
    case "paragraph":
      return children.join("") + "\n\n";
    case "heading":
      return "#".repeat(Number(n.attrs?.level ?? 1)) + " " + children.join("") + "\n\n";
    case "bulletList":
      return children.join("") + "\n";
    case "orderedList":
      return children.map((c, i) => c.replace(/^- /, `${i + 1}. `)).join("") + "\n";
    case "listItem":
      return "- " + children.join("").trim().replace(/\n\n/g, "\n  ") + "\n";
    case "codeBlock":
      return "```" + String(n.attrs?.language ?? "") + "\n" + children.join("") + "\n```\n\n";
    case "blockquote":
      return children.join("").trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    case "rule":
      return "---\n\n";
    case "inlineCard":
    case "mention":
    case "emoji":
      return String(n.attrs?.url ?? n.attrs?.text ?? n.attrs?.shortName ?? "");
    default:
      return children.join("");
  }
}
