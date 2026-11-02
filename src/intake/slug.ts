const MAX = 15;

/** Lowercase, with runs of anything but letters and digits collapsed to single hyphens. */
export function hyphenate(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Title hyphenated and cut at 15 characters on a word boundary. */
export function slugify(title: string): string {
  const words = hyphenate(title).split("-").filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, MAX);
  return slug || "ticket";
}
