import type { RepoConfig } from "../../../server/config.ts";
import type { ActionListing } from "../../../api/views.ts";
import { Setting } from "../Setting.tsx";

/** The Actions config.yaml defines, read-only: they run shell commands, so they are edited in the file. */
export function Actions({ actions }: { actions: ActionListing[] }) {
  return (
    <Setting title="Actions" about="Shell commands an action Stage runs. A repo's own Action replaces a global one with the same name." role="config-actions">
      {actions.length ? (
        actions.map((a) => (
          <div key={`${a.repo ?? ""}/${a.name}`} className="action-def" data-action={a.name}>
            <h4>
              {a.name}
              <span className="chip">{a.repo ? `repo ${a.repo}` : "global"}</span>
              <span className="chip">params: {a.params.join(", ") || "none"}</span>
              <span className="chip">timeout {a.timeout}</span>
            </h4>
            <pre>{a.run}</pre>
          </div>
        ))
      ) : (
        <div className="note">None yet. Add one under actions: in config.yaml.</div>
      )}
    </Setting>
  );
}

export function Repos({ repos }: { repos: Record<string, RepoConfig> }) {
  const rows = Object.entries(repos);
  return (
    <Setting title="Repos" about="The repos Laisso takes Tickets for, and the Pipeline each starts on." role="config-repos">
      {rows.length ? (
        <table className="repos">
          <thead>
            <tr>
              {["Repo", "Tracker", "Pipeline", "Agent Profile", "Path"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, r]) => (
              <tr key={name}>
                <td>
                  <strong>{name}</strong>
                </td>
                <td>{`${r.tracker} ${r.project}`}</td>
                <td>{r.pipeline}</td>
                <td>{r.default_profile || "global default"}</td>
                <td className="path">{r.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="note">None yet. Add one under repos: in config.yaml.</div>
      )}
    </Setting>
  );
}
