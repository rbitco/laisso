import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionListing, ConfigFile, PipelineListing } from "../../../api/views.ts";
import { api } from "../api.ts";
import { useEvents } from "../events.ts";
import { showNotice } from "../notice.tsx";
import { EditorHead, GroupTitle } from "../Setting.tsx";
import { SettingsForm } from "./SettingsForm.tsx";
import { Actions, Repos } from "./FromConfigFile.tsx";
import { ProfileTiles } from "../profiles/ProfileTiles.tsx";
import { PrListsForm } from "./PrListsForm.tsx";

export interface ConfigPageProps {
  /** Bumped each time the page is shown, so it reads config afresh. */
  visit: number;
}

interface Loaded {
  file: ConfigFile;
  actions: ActionListing[];
  pipelines: PipelineListing[];
}

/**
 * Config, in four groups by how each saves: settings saved with Save changes; Agent Profiles, which save from
 * their drawer at once; PR Lists, edited as YAML and saved with Save PR Lists; and Actions and repos, which are read-only here and edited in config.yaml by hand.
 * It reads config again whenever the server says config changed.
 */
export function ConfigPage({ visit }: ConfigPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const reads = useRef(0);
  const read = useCallback(async () => {
    const mine = ++reads.current;
    try {
      const [file, actions, pipelines] = await Promise.all([api<ConfigFile>("/api/config"), api<ActionListing[]>("/api/actions"), api<PipelineListing[]>("/api/pipelines")]);
      // A slower, older read must not replace a newer one.
      if (mine === reads.current) setLoaded({ file, actions, pipelines });
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => void read(), [read, visit]);
  useEvents(["config"], () => void read());

  if (!loaded) return null;
  return (
    <div className="ed">
      <EditorHead title="Config" file={loaded.file.file} />
      <GroupTitle title="Settings" how="Saved with Save changes" />
      <SettingsForm config={loaded.file.config} onSaved={(file) => setLoaded((was) => was && { ...was, file })} />
      <GroupTitle title="Agent Profiles" how="Each saves from its editor as you go" />
      <ProfileTiles config={loaded.file.config} pipelines={loaded.pipelines} onChange={(config) => setLoaded((was) => was && { ...was, file: { ...was.file, config } })} />
      <GroupTitle title="PR Lists" how="YAML, saved with Save PR Lists" />
      <PrListsForm visit={visit} />
      <GroupTitle title="From config.yaml" how="Read-only here; edit the file by hand" />
      <div className="sheet readonly">
        <Actions actions={loaded.actions} />
        <Repos repos={loaded.file.config.repos} />
      </div>
    </div>
  );
}
