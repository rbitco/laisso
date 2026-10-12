import { createRoot, type Root } from "react-dom/client";
import { TicketPage } from "./TicketPage.tsx";

let root: Root | null = null;
let visit = 0;

/**
 * The old script's way into the React Ticket page: each call reads Ticket `id` afresh into `panel`, with the sidebar
 * of Tickets (done and Abandoned too when `all`) in `side`. `shown` follows once the Ticket is drawn, so the old
 * script swaps the page in then rather than showing the last one meanwhile.
 */
export function showTicket(panel: HTMLElement, side: HTMLElement, id: string, all: boolean, shown: () => void): void {
  root ??= createRoot(panel);
  root.render(<TicketPage id={id} visit={++visit} all={all} side={side} onShown={shown} />);
}

/** Leaves the Ticket page: nothing on it reads or listens any more, and a read still out never draws. */
export function hideTicket(): void {
  root?.render(null);
}
