import { useRef, useState } from "react";
import { useEvents } from "./events.ts";
import { Notice, showNotice } from "./notice.tsx";
import { usePlace, type Place } from "./route.ts";
import { ConfirmIntake, IntakeForm, type Detected } from "./header/Intake.tsx";
import { Tick } from "./header/Tick.tsx";
import { Ledger } from "./ledger/Ledger.tsx";
import { TicketPage } from "./ticket/TicketPage.tsx";
import { PipelinesPage } from "./pipelines/PipelinesPage.tsx";
import { ConfigPage } from "./config/ConfigPage.tsx";
import { ProfileDrawerHost } from "./profiles/drawer.tsx";

const VIEWS = [
  { href: "#", view: "ledger", name: "Tickets" },
  { href: "#pipelines", view: "pipelines", name: "Pipelines" },
  { href: "#config", view: "config", name: "Config" },
] as const;

const LEDGER: Place = { route: { view: "ledger" }, visit: 0 };

/**
 * The dashboard: the header (intake, the Tick dot and Check now, the view links), then the view the hash names. A
 * Ticket's page swaps in once its data is here, so until then the view before it stays; with a Ticket open the Ledger
 * collapses to a sidebar beside it. When Lasso comes back after a restart, the view shown reads everything again, as
 * it may have missed some changes.
 */
export function App() {
  const { place, reread } = usePlace();
  const { route } = place;

  // The last view that was not a Ticket, with its visit, shown while a Ticket loads.
  const [before, setBefore] = useState<Place>(() => (route.view === "detail" ? LEDGER : place));
  if (route.view !== "detail" && before !== place) setBefore(place);
  // Whether the Ticket asked for has been drawn.
  const [ticketShown, setTicketShown] = useState(false);
  if (route.view !== "detail" && ticketShown) setTicketShown(false);
  const shown = route.view === "detail" && !ticketShown ? before : place;
  const view = shown.route.view;

  const [all, setAll] = useState(false);
  const [side, setSide] = useState<HTMLElement | null>(null);
  const [intakeText, setIntakeText] = useState("");
  const [intake, setIntake] = useState<(Detected & { n: number }) | null>(null);

  const everOpen = useRef(false);
  useEvents(["hello"], () => {
    if (everOpen.current) reread();
    everOpen.current = true;
  });

  const on = route.view === "detail" ? "ledger" : route.view;
  return (
    <>
      <header>
        <h1>LASSO</h1>
        <IntakeForm text={intakeText} onText={setIntakeText} onDetected={(d) => setIntake((was) => ({ ...d, n: (was?.n ?? 0) + 1 }))} />
        <Tick onChecked={reread} />
        <nav className="views">
          {VIEWS.map((v) => (
            <a key={v.view} href={v.href} className={v.view === on ? "on" : undefined}>
              {v.name}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <Notice />
        {intake && (
          <ConfirmIntake
            key={intake.n}
            detected={intake}
            onCancel={() => setIntake(null)}
            onAdded={(t) => {
              setIntake(null);
              setIntakeText("");
              if (t.branchExisted) showNotice("checked out existing branch " + t.branch);
              location.hash = "";
              reread();
            }}
          />
        )}
        <div className={"dwrap" + (view === "detail" ? " open" : "")} data-role="layout">
          <aside className="dside" data-role="side" hidden={view !== "detail"} ref={setSide} />
          <div className="dmain">
            <div className="ledger-tools" data-role="ledger-tools" hidden={view !== "ledger"}>
              <label>
                <input type="checkbox" data-role="show-ended" checked={all} onChange={(ev) => setAll(ev.target.checked)} /> Show done and Abandoned
              </label>
            </div>
            <section data-role="ledger" aria-label="Tickets" hidden={view !== "ledger"}>
              {view === "ledger" && <Ledger all={all} visit={shown.visit} />}
            </section>
            <section data-role="detail" className="detail" hidden={view !== "detail"}>
              {route.view === "detail" && <TicketPage id={route.id} visit={place.visit} all={all} side={side} onShown={() => setTicketShown(true)} />}
            </section>
            <section data-role="pipelines" className="panel editor-panel" aria-label="Pipelines" hidden={view !== "pipelines"}>
              {shown.route.view === "pipelines" && <PipelinesPage name={shown.route.name} version={shown.route.version} visit={shown.visit} />}
            </section>
            <section data-role="config" className="panel editor-panel" aria-label="Config" hidden={view !== "config"}>
              {view === "config" && <ConfigPage visit={shown.visit} />}
            </section>
          </div>
        </div>
      </main>
      <ProfileDrawerHost />
    </>
  );
}
