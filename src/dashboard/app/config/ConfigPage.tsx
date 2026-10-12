import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Config } from "../../../server/config.ts";
import type { ActionListing, ConfigFile } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.ts";
import { EditorHead, GroupTitle } from "../Setting.tsx";
import { SettingsForm } from "./SettingsForm.tsx";
import { Actions, Repos } from "./FromConfigFile.tsx";

export interface ConfigPageProps {
  /** Bumped each time the page is shown, so it reads config afresh. */
  visit: number;
  /** Draws the Agent Profiles group into `host`; the old script still owns it (ADR 0012). */
  profiles?: (host: HTMLElement, config: Config) => void;
}

interface Loaded {
  file: ConfigFile;
  actions: ActionListing[];
}

/**
 * Config, in three groups by how each saves: settings saved with Save changes; Agent Profiles, which save from
 * their drawer at once; and Actions and repos, which are read-only here and edited in config.yaml by hand.
 * It reads config again whenever the server says config changed.
 */
export function ConfigPage({ visit, profiles }: ConfigPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const [file, actions] = await Promise.all([api<ConfigFile>("/api/config"), api<ActionListing[]>("/api/actions")]);
      // A slower, older read must not replace a newer one.
      if (mine === reads.current) setLoaded({ file, actions });
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => void read(), [read, visit]);
  useEvents(["config"], () => void read());

  const host = useRef<HTMLDivElement>(null);
  const config = loaded?.file.config;
  useLayoutEffect(() => {
    if (host.current && config && profiles) profiles(host.current, config);
  }, [config, profiles]);

  if (!loaded) return null;
  return (
    <div className="ed">
      <EditorHead title="Config" file={loaded.file.file} />
      <GroupTitle title="Settings" how="Saved with Save changes" />
      <SettingsForm config={loaded.file.config} onSaved={(file) => setLoaded((was) => was && { ...was, file })} />
      <GroupTitle title="Agent Profiles" how="Each saves from its editor as you go" />
      <div ref={host} data-role="config-profiles-host" />
      <GroupTitle title="From config.yaml" how="Read-only here; edit the file by hand" />
      <div className="sheet readonly">
        <Actions actions={loaded.actions} />
        <Repos repos={loaded.file.config.repos} />
      </div>
    </div>
  );
}
