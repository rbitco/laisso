import type { KeyboardEvent } from "react";
import type { Config } from "../../../server/config.ts";
import type { PipelineListing } from "../../../api/views.ts";
import { profileIndex, profileSummary, profileUsers, scopedProfile, scopeNote, usedByLine } from "../../metro.js";
import { openProfileDrawer } from "./drawer.tsx";

/**
 * The Agent Profiles, one tile each: name, default marker, repo overrides ("overridden in app") or the repos a
 * repo-only profile lives in ("only in app"), what each mode runs, and the Stages that run it. A repo-only tile shows
 * its first repo's definition. A click opens the profile drawer; `onChange` gets the config each save there wrote.
 */
export function ProfileTiles({ config, pipelines, onChange }: { config: Config; pipelines: PipelineListing[]; onChange: (config: Config) => void }) {
  const index = profileIndex(config);
  return (
    <div className="sheet" style={{ padding: 16 }} data-role="config-profiles">
      {index.length ? (
        <div className="pf-list" data-role="profile-list">
          {index.map((entry) => {
            const { name } = entry;
            const note = scopeNote(entry);
            const used = usedByLine(profileUsers(name, pipelines, config.default_profile));
            const open = () => openProfileDrawer(name, { onChange });
            const onKey = (ev: KeyboardEvent) => {
              if (ev.key !== "Enter" && ev.key !== " ") return;
              ev.preventDefault();
              open();
            };
            return (
              <a key={name} data-profile={name} tabIndex={0} role="button" aria-label={`edit Agent Profile ${name}`} onClick={open} onKeyDown={onKey}>
                <b>
                  {name}
                  {entry.global && name === config.default_profile && <span className="chip is-default">default</span>}
                  {note && (
                    <span className="chip" data-role="profile-scope">
                      {note}
                    </span>
                  )}
                </b>
                <span className="pf-summary">{profileSummary(scopedProfile(config, name, entry.global ? null : entry.repos[0])!)}</span>
                <span className="why" title={used}>
                  {used}
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="why">None yet. Open a Stage's profile to make one.</div>
      )}
    </div>
  );
}
