import { paint, type Colour } from "./paint.ts";

/** The logo's pixel grid, 14 wide and 12 tall: # is rope, a blank is empty. Row pairs become one line of half blocks. */
const GRID = [
  "    ######    ",
  "  ##      ##  ",
  " #          # ",
  "#            #",
  "#            #",
  "#            #",
  " #          # ",
  "  ##      ##  ",
  "    # ####    ",
  "     #        ",
  "   ##         ",
  "   ##         ",
];

/** The columns of the line between rows 4 and 5 that hold the bubble's three dots. */
const DOTS = new Set([4, 7, 10]);

/** The rope's gradient, left to right: the dashboard's dark-theme violet, red and accent orange. */
const STOPS: Array<[number, number, number]> = [
  [0xb0, 0x9a, 0xe6],
  [0xef, 0x5b, 0x4c],
  [0xee, 0x7d, 0x55],
];

/** Laisso's pixel speech bubble as six lines of half blocks, its rope shaded column by column. */
export function logo(colour: Colour): string[] {
  const width = GRID[0]!.length;
  const lines: string[] = [];
  for (let row = 0; row < GRID.length; row += 2) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const top = GRID[row]![col] === "#";
      const bottom = GRID[row + 1]![col] === "#";
      if (row === 4 && DOTS.has(col)) line += "•";
      else if (!top && !bottom) line += " ";
      else line += paint(colour, top && bottom ? "█" : top ? "▀" : "▄", { rgb: shade(col / (width - 1)) });
    }
    lines.push(line);
  }
  return lines;
}

/** The colour at `t` (0 to 1) along the rope, the middle stop sitting a little past halfway as in the dashboard's. */
function shade(t: number): [number, number, number] {
  const [a, b, local] = t < 0.55 ? [STOPS[0]!, STOPS[1]!, t / 0.55] : [STOPS[1]!, STOPS[2]!, (t - 0.55) / 0.45];
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * local)) as [number, number, number];
}
