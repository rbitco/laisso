/** How much colour the terminal takes: none (NO_COLOR, or no colour support), the 256-colour palette, or 24-bit. */
export type Colour = "none" | "256" | "truecolor";

export interface Style {
  rgb?: [number, number, number];
  bold?: boolean;
  dim?: boolean;
}

/** The terminal's colour depth from the environment: NO_COLOR wins, then COLORTERM, then TERM. */
export function colourOf(env: NodeJS.ProcessEnv): Colour {
  if (env.NO_COLOR) return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "truecolor";
  if (!env.TERM || env.TERM === "dumb") return "none";
  return "256";
}

/** `text` wrapped in the escapes for `style`, or bare when the terminal takes no colour (bold and dim included). */
export function paint(colour: Colour, text: string, style: Style): string {
  if (colour === "none" || !text) return text;
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.rgb) codes.push(colour === "truecolor" ? `38;2;${style.rgb.join(";")}` : `38;5;${to256(style.rgb)}`);
  return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

/** The nearest colour in the 6×6×6 cube of the 256-colour palette. */
function to256([r, g, b]: [number, number, number]): number {
  const step = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

/** How many columns `text` takes on screen: escapes take none. */
export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
