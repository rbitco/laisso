import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { startLassoWithRepos, waitFor, claudeFixture, type Lasso } from "./harness.ts";
import type { ConfigFile, TicketDetail, IntakeResult } from "../src/api/views.ts";
import type { ProfileConfig } from "../src/server/config.ts";

// Seam one: the profile drawer's saves, through the API the dashboard uses. Each writes
// config.yaml in place with its comments, is checked as config load checks it, and
// reaches the next Session with no restart (LASSO-72).
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PROFILES: Record<string, ProfileConfig> = {
  "claude-opus": { runner: "claude", model: "opus", args: ["--verbose"] },
  "claude-fable": { runner: "claude", model: "fable", permission: "auto" },
};

// implement names claude-fable; notes inherits default_profile (claude-opus).
const WORK = `stages:
  - name: implement
    prompt: Do the work.
    profile: claude-fable
    artifact: commits-on-branch
  - name: notes
    prompt: Write NOTES.md.
    artifact: file NOTES.md
`;

async function lassoWith() {
  const started = await startLassoWithRepos({ app: { pipeline: "work" } }, { profiles: PROFILES, default_profile: "claude-opus" }, { work: WORK });
  running.push(started.lasso);
  return started.lasso;
}

const json = (body: unknown) => JSON.stringify(body);
const configPath = (lasso: Lasso) => path.join(lasso.home, "config.yaml");
const putProfile = (lasso: Lasso, name: string, profile: unknown, create = false) =>
  lasso.api<ConfigFile>(`/api/profiles/${name}`, { method: "PUT", body: json({ profile, create }) });
const raw = (lasso: Lasso, route: string, init: RequestInit) => lasso.api<Response>(route, { ...init, raw: true });
const detailOf = (lasso: Lasso, id: string) => lasso.api<TicketDetail>(`/api/tickets/${id}`);

/** Comments a person added by hand: one above everything, one beside a profile's model. */
async function annotate(lasso: Lasso) {
  const file = configPath(lasso);
  await writeFile(file, "# my config\n" + (await readFile(file, "utf8")).replace("model: opus", "model: opus # the strong one"));
}

describe("saving Agent Profiles", () => {
  it("creates, edits and deletes a global profile in config.yaml, keeping comments, and the next Session runs the edit", async () => {
    const lasso = await lassoWith();
    await annotate(lasso);

    // Create: written whole, args on one line, and parsed back as config load reads it.
    const created = await lasso.api<Response>("/api/profiles/claude-haiku", { method: "PUT", body: json({ create: true, profile: { runner: "claude", model: "haiku", args: ["--debug"], human: { permission: "edits" } } }), raw: true });
    expect(created.status).toBe(201);
    const made = (await created.json()) as ConfigFile;
    expect(made.config.profiles["claude-haiku"]).toEqual({ runner: "claude", model: "haiku", args: ["--debug"], human: { permission: "edits" } });
    expect(made.text).toContain("# my config");
    expect(made.text).toContain("model: opus # the strong one");
    expect(made.text).toMatch(/args: \[ ?--debug ?\]/);
    expect(await readFile(configPath(lasso), "utf8")).toBe(made.text);

    // Edit: the profile is replaced whole (args dropped), and the comment beside a changed value stays.
    const edited = await putProfile(lasso, "claude-opus", { runner: "claude", model: "sonnet", effort: "high" });
    expect(edited.config.profiles["claude-opus"]).toEqual({ runner: "claude", model: "sonnet", effort: "high" });
    expect(edited.text).toContain("model: sonnet # the strong one");
    expect(edited.text).toContain("# my config");
    expect((await lasso.api<ConfigFile>("/api/config")).config.profiles["claude-opus"]).toEqual({ runner: "claude", model: "sonnet", effort: "high" });

    // The next Session reads it: notes inherits claude-opus from default_profile.
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo: "app", pipeline: "work" }) });
    await lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]], files: { "NOTES.md": "notes\n" } });
    await lasso.api("/api/check-now", { method: "POST" });
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).stage.name === "notes" ? true : null), "notes to be current");
    await lasso.api("/api/check-now", { method: "POST" });
    const done = await waitFor(async () => { const d = await detailOf(lasso, ticket.id); return d.state === "done" ? d : null; }, "the Ticket to be done");
    const [implement, notes] = await lasso.runner.calls();
    expect(implement!.argv.slice(-2)).toEqual(["--model", "fable"]);
    expect(notes!.argv.slice(-4)).toEqual(["--model", "sonnet", "--effort", "high"]);
    expect(done.sessions.find((s) => s.stage === "notes")!.profile).toEqual({ name: "claude-opus", runner: "claude", model: "sonnet", effort: "high", permission: null, args: [] });

    // Delete: a profile nothing names goes at once, and the rest of the file is as it was.
    const deleted = await lasso.api<ConfigFile>("/api/profiles/claude-haiku", { method: "DELETE" });
    expect(Object.keys(deleted.config.profiles).sort()).toEqual(["claude-fable", "claude-opus"]);
    expect(deleted.text).not.toContain("claude-haiku");
    expect(deleted.text).toContain("# my config");
    expect(deleted.text).toContain("model: sonnet # the strong one");
  });

  it("sets the global default_profile in place, refusing a name config.yaml lacks", async () => {
    const lasso = await lassoWith();
    await annotate(lasso);
    const set = await lasso.api<ConfigFile>("/api/config", { method: "PATCH", body: json({ default_profile: "claude-fable" }) });
    expect(set.config.default_profile).toBe("claude-fable");
    expect(set.text).toContain("# my config");
    expect(parse(await readFile(configPath(lasso), "utf8")).default_profile).toBe("claude-fable");
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ default_profile: "nobody" }) })).rejects.toThrow(/no profile named nobody in config\.yaml/);
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ default_profile: null }) })).rejects.toThrow(/default_profile must name a profile/);
    expect(parse(await readFile(configPath(lasso), "utf8")).default_profile).toBe("claude-fable");
  });

  it("refuses bad values with the config-load message, and leaves the file alone", async () => {
    const lasso = await lassoWith();
    const text = await readFile(configPath(lasso), "utf8");
    const refused = async (name: string, profile: unknown, create: boolean, message: RegExp) => {
      const res = await raw(lasso, `/api/profiles/${name}`, { method: "PUT", body: json({ profile, create }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    };
    await refused("claude-opus", { runner: "claude", effort: "huge" }, false, /profiles\.claude-opus\.effort must be one of low, medium, high, xhigh, max, not huge/);
    await refused("claude-opus", { runner: "claude", human: { permission: "yolo" } }, false, /profiles\.claude-opus\.human\.permission must be one of auto, edits, full, not yolo/);
    await refused("claude-opus", { runner: "gemini" }, false, /profiles\.claude-opus: runner must be one of claude, codex, pi, not gemini/);
    await refused("claude-opus", { runner: "claude", colour: "red" }, false, /profiles\.claude-opus: unknown field colour/);
    await refused("claude-opus", { runner: "claude", human: { skills_dir: "/x" } }, false, /profiles\.claude-opus\.human: unknown field skills_dir/);
    await refused("claude-opus", { runner: "claude", args: "--verbose" }, false, /profiles\.claude-opus\.args must be a list of arguments/);
    await refused("Big Name", { runner: "claude" }, true, /a profile name is lowercase letters, digits, dots, hyphens, and underscores/);
    await refused("claude-opus", { runner: "claude" }, true, /profile claude-opus already exists/);
    await refused("nobody", { runner: "claude" }, false, /no profile named nobody in config\.yaml/);
    await refused("claude-opus", "opus", false, /profile must be a mapping of its fields/);
    // The whole set of profiles still goes through PUT one at a time, not the config patch.
    await expect(lasso.api("/api/config", { method: "PATCH", body: json({ profiles: {} }) })).rejects.toThrow(/profiles are saved one at a time/);
    expect(await readFile(configPath(lasso), "utf8")).toBe(text);
  });

  it("refuses to delete the default_profile, and deletes a profile Stages name only once confirmed", async () => {
    const lasso = await lassoWith();
    const text = await readFile(configPath(lasso), "utf8");
    const gone = await raw(lasso, "/api/profiles/nobody", { method: "DELETE" });
    expect(gone.status).toBe(404);

    const isDefault = await raw(lasso, "/api/profiles/claude-opus", { method: "DELETE" });
    expect(isDefault.status).toBe(400);
    expect(((await isDefault.json()) as { error: string }).error).toBe("claude-opus is the default_profile; make another profile the default first");

    // claude-fable is named by work/implement and by the shipped default Pipeline: the first delete lists them and waits for confirmation.
    const named = await raw(lasso, "/api/profiles/claude-fable", { method: "DELETE" });
    expect(named.status).toBe(409);
    expect(await named.json()).toEqual({ error: "claude-fable is named by default/grill, default/plan, default/code-review, work/implement; their next Sessions are Flagged once it is gone", usedBy: ["default/grill", "default/plan", "default/code-review", "work/implement"], confirm: true });
    expect(await readFile(configPath(lasso), "utf8")).toBe(text);

    const confirmed = await lasso.api<ConfigFile>("/api/profiles/claude-fable?confirm=1", { method: "DELETE" });
    expect(Object.keys(confirmed.config.profiles)).toEqual(["claude-opus"]);
    // The Pipeline still names it, so Intake now refuses it, naming the profile, rather than run another.
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo: "app", pipeline: "work" }) }).catch((e: Error) => e);
    expect(ticket).toBeInstanceOf(Error);
    expect((ticket as Error).message).toMatch(/claude-fable/);
  });

  it("keeps the shipped profiles when config.yaml has no profiles: of its own", async () => {
    const lasso = await lassoWith();
    await writeFile(configPath(lasso), "# hand-written\ntick: 3600\n");
    const made = await putProfile(lasso, "codex-high", { runner: "codex", model: "gpt-6-sol", effort: "high", skills_dir: "/opt/skills" }, true);
    expect(Object.keys(made.config.profiles)).toEqual(["claude-fable", "claude-opus", "claude-sonnet", "codex-high"]);
    expect(made.text).toContain("# hand-written");
    expect(made.config.default_profile).toBe("claude-opus");

    await lasso.api("/api/config", { method: "PATCH", body: json({ default_profile: "codex-high" }) });
    for (const name of ["claude-fable", "claude-opus", "claude-sonnet"]) await lasso.api(`/api/profiles/${name}?confirm=1`, { method: "DELETE" });
    const left = await lasso.api<ConfigFile>("/api/config");
    expect(Object.keys(left.config.profiles)).toEqual(["codex-high"]);
    expect(left.config.profiles["codex-high"]).toEqual({ runner: "codex", model: "gpt-6-sol", effort: "high", skills_dir: "/opt/skills" });
  });
});
