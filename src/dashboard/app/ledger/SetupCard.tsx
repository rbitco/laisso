import { useEffect, useState } from "react";
import type { ConfigFile } from "../../../api/views.ts";
import { api } from "../api.ts";
import { showNotice } from "../notice.tsx";
import { message } from "../ticket/ticket.ts";

/** What /api/setup answers: where the setup Runner opened, and under which profile. */
interface SetupOpened {
  terminal: string;
  profile: string;
}

const TERMINAL_NAMES: Record<string, string> = { "terminal-app": "Terminal", tmux: "a tmux window", herdr: "a herdr tab" };

/**
 * The Ledger's empty state on a Laisso with no repos yet: Set up Laisso opens `laisso setup` in a terminal, where a
 * coding agent sets up repos and Pipelines with the person. With repos it is the plain empty line it replaces.
 */
export function SetupCard({ empty }: { empty: string }) {
  const [repos, setRepos] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<SetupOpened | null>(null);
  useEffect(() => {
    let live = true;
    // A config that cannot be read shows the plain line: the card is only for a home known to have no repos.
    api<ConfigFile>("/api/config")
      .then((c) => live && setRepos(Object.keys(c.config.repos ?? {}).length))
      .catch(() => live && setRepos(1));
    return () => void (live = false);
  }, []);

  if (repos === null) return null;
  if (repos > 0) return <p className="empty">{empty}</p>;
  const open = async () => {
    setBusy(true);
    try {
      setOpened(await api<SetupOpened>("/api/setup", { method: "POST" }));
    } catch (error) {
      showNotice(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="setup-card" data-role="setup">
      <h2>Set up Laisso</h2>
      <p>
        Laisso has no repos yet. Setup opens your coding agent in a terminal to add your repos, shape a default Pipeline to how
        you work, and check every tool Laisso needs. You can also run <code>laisso setup</code> yourself.
      </p>
      {opened ? (
        <p className="muted">
          Opened in {TERMINAL_NAMES[opened.terminal] ?? opened.terminal} with profile {opened.profile}. Finish there, then paste a reference or a prompt
          above to start a Ticket.
        </p>
      ) : (
        <button className={busy ? "primary busy" : "primary"} disabled={busy} onClick={() => void open()}>
          Set up Laisso
        </button>
      )}
    </section>
  );
}
