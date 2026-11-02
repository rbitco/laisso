# Budgets, Flags and concurrency

## Budget

Every Ticket runs under a Budget:

| Limit      | Counts                       |
| ---------- | ---------------------------- |
| `rounds`   | per repeating Stage          |
| `attempts` | per Stage                    |
| `wallTime` | per headless Session         |
| `spend`    | USD per Ticket               |

`config.yaml` sets the defaults. A Pipeline may tighten or loosen them
(`budget:` on the Pipeline for `spend`, on a Stage for the rest), and Extend
on a Ticket overrides both.

## Flags

Laisso retries an interrupted or exhausted Session while attempts remain,
and Flags the Ticket when they run out or the spend is used up. A Flagged
Ticket offers six exits in the dashboard and the API: Retry, Resume, Extend,
Mark done, Skip and Abandon.

Skip also passes over a Stage that has not started yet, such as a second
review you don't need: from a Start gate, or while the Stage is ready or
queued. The Pipeline's hold after that Stage still applies, and the Ticket
page marks the Stage Skipped.

## Concurrency

`concurrency:` in `config.yaml` caps how many headless Sessions run at once
across all Tickets (default 3). Terminal Sessions never hold a slot.

Tickets past the cap queue in the order they became runnable and show their
position in the Ledger; each tick starts the oldest in line as slots free
up. A change to the cap applies on the next tick without a restart. Retry
and Resume, being explicit human acts, start regardless of the cap.
