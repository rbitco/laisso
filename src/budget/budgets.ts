import type { Config } from "../server/config.ts";
import type { Pipeline, Stage } from "../pipeline/load.ts";
import type { TicketRow } from "../store/tickets.ts";
import type { Sessions, SessionRow } from "../store/sessions.ts";
import { roundDue, type PrLinks } from "../store/links.ts";
import { resolveBudget, usageOf, refusalOf, budgetView, type Budget, type Usage, type Refusal, type BudgetView } from "./budget.ts";

/** A Ticket's Budget and what it has used, read from the store on every ask so counters are never cached. */
export class Budgets {
  private config: Config;
  private sessions: Sessions;
  private links: PrLinks;

  constructor(deps: { config: Config; sessions: Sessions; links: PrLinks }) {
    this.config = deps.config;
    this.sessions = deps.sessions;
    this.links = deps.links;
  }

  resolve(ticket: TicketRow, pipeline: Pipeline | null, stage: Stage | null): Budget {
    return resolveBudget(this.config, pipeline, stage, ticket);
  }

  /** `rows` are the Ticket's Sessions when the caller already holds them; otherwise they are read afresh. */
  usage(ticket: TicketRow, pipeline: Pipeline | null, stage: Stage | null, rows: SessionRow[] = this.sessions.forTicket(ticket.id)): Usage {
    return usageOf(rows, pipeline, stage);
  }

  /** Null when the next Session of the Stage may start. A repeating Stage with a Round due would open one. */
  refusal(ticket: TicketRow, pipeline: Pipeline, stage: Stage): Refusal | null {
    const opensRound = stage.kind === "runner" && stage.repeat !== null && roundDue(this.links.links(ticket.id));
    return refusalOf(this.resolve(ticket, pipeline, stage), this.usage(ticket, pipeline, stage), stage, opensRound);
  }

  view(ticket: TicketRow, pipeline: Pipeline | null, stage: Stage | null, rows?: SessionRow[]): BudgetView {
    return budgetView(this.resolve(ticket, pipeline, stage), this.usage(ticket, pipeline, stage, rows), ticket, stage);
  }
}
