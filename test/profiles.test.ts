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

describe("saving a repo's own Agent Profiles", () => {
  // implement names claude-opus; app and web both run it, and neither has profiles of its own yet.
  const ONE = `stages:
  - name: implement
    prompt: Do the work.
    profile: claude-opus
    artifact: commits-on-branch
`;
  async function twoRepos(app: { profiles?: Record<string, ProfileConfig>; default_profile?: string } = {}) {
    const started = await startLassoWithRepos({ app: { pipeline: "one", ...app }, web: { pipeline: "one" } }, { profiles: PROFILES, default_profile: "claude-opus" }, { one: ONE });
    running.push(started.lasso);
    await started.lasso.runner.script({ stdout: claudeFixture("success.json"), commands: [["git", "commit", "-q", "--allow-empty", "-m", "work"]] });
    return started.lasso;
  }
  const putRepoProfile = (lasso: Lasso, repo: string, name: string, profile: unknown, create = false) =>
    lasso.api<ConfigFile>(`/api/repos/${repo}/profiles/${name}`, { method: "PUT", body: json({ profile, create }) });
  /** Run one Ticket of Pipeline one in a repo to done, and hand back its Session's argv. */
  async function argvIn(lasso: Lasso, repo: string, pipeline = "one") {
    const ticket = await lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: json({ input: "Add dark mode", repo, pipeline }) });
    await lasso.api("/api/check-now", { method: "POST" });
    await waitFor(async () => ((await detailOf(lasso, ticket.id)).state === "done" ? true : null), "the Ticket to be done");
    return (await lasso.runner.calls()).at(-1)!.argv;
  }

  it("overrides a profile for one repo by copying the global, runs edits there only, and removing it returns the repo to the global", async () => {
    const lasso = await twoRepos();
    await annotate(lasso);
    const file = configPath(lasso);
    await writeFile(file, (await readFile(file, "utf8")).replace(/^ {2}app:$/m, "  # the main checkout\n  app:"));

    // "Override for repo…": the global profile, copied into app's profiles:, comments kept.
    const global = (await lasso.api<ConfigFile>("/api/config")).config.profiles["claude-opus"];
    const created = await lasso.api<Response>("/api/repos/app/profiles/claude-opus", { method: "PUT", raw: true, body: json({ profile: global, create: true }) });
    expect(created.status).toBe(201);
    const made = (await created.json()) as ConfigFile;
    expect(made.config.repos.app!.profiles).toEqual({ "claude-opus": PROFILES["claude-opus"] });
    expect(made.config.repos.web!.profiles).toEqual({});
    expect(made.text).toMatch(/^ {2}# the main checkout\n {2}app:\n(?: {4}.*\n)* {4}profiles:\n {6}claude-opus:\n {8}runner: claude\n {8}model: opus\n {8}args: \[ ?--verbose ?\]\n/m);
    for (const kept of ["# my config", "model: opus # the strong one"]) expect(made.text).toContain(kept);

    // Editing app's tab changes app's Sessions only; the global and web are as they were.
    const edited = await putRepoProfile(lasso, "app", "claude-opus", { runner: "claude", model: "sonnet", effort: "high" });
    expect(edited.config.repos.app!.profiles["claude-opus"]).toEqual({ runner: "claude", model: "sonnet", effort: "high" });
    expect(edited.config.profiles["claude-opus"]).toEqual(PROFILES["claude-opus"]);
    for (const kept of ["# my config", "model: opus # the strong one", "# the main checkout\n  app:"]) expect(edited.text).toContain(kept);
    expect((await argvIn(lasso, "app")).slice(-4)).toEqual(["--model", "sonnet", "--effort", "high"]);
    expect((await argvIn(lasso, "web")).slice(-3)).toEqual(["--model", "opus", "--verbose"]);

    // Removing the override returns app to the global profile at its next Session.
    const removed = await lasso.api<ConfigFile>("/api/repos/app/profiles/claude-opus", { method: "DELETE" });
    expect(removed.config.repos.app!.profiles).toEqual({});
    expect(removed.config.profiles["claude-opus"]).toEqual(PROFILES["claude-opus"]);
    expect(removed.text).not.toContain("model: sonnet");
    for (const kept of ["# my config", "model: opus # the strong one", "# the main checkout\n  app:"]) expect(removed.text).toContain(kept);
    expect(await readFile(file, "utf8")).toBe(removed.text);
    expect((await argvIn(lasso, "app")).slice(-3)).toEqual(["--model", "opus", "--verbose"]);
  });

  it("refuses bad values with the config-load message, unknown repos and missing profiles, and leaves the file alone", async () => {
    const lasso = await twoRepos({ profiles: { solo: { runner: "claude", model: "haiku" } }, default_profile: "solo" });
    const text = await readFile(configPath(lasso), "utf8");
    const refused = async (route: string, init: RequestInit, status: number, message: RegExp) => {
      const res = await raw(lasso, route, init);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    };
    const put = (profile: unknown, create = false) => ({ method: "PUT", body: json({ profile, create }) });
    await refused("/api/repos/app/profiles/claude-opus", put({ runner: "claude", effort: "huge" }, true), 400, /repos\.app\.profiles\.claude-opus\.effort must be one of low, medium, high, xhigh, max, not huge/);
    await refused("/api/repos/app/profiles/solo", put({ runner: "gemini" }), 400, /repos\.app\.profiles\.solo: runner must be one of claude, codex, pi, not gemini/);
    await refused("/api/repos/app/profiles/solo", put({ runner: "claude", colour: "red" }), 400, /repos\.app\.profiles\.solo: unknown field colour/);
    await refused("/api/repos/app/profiles/solo", put({ runner: "claude" }, true), 400, /profile solo already exists in repo app/);
    await refused("/api/repos/web/profiles/claude-opus", put({ runner: "claude" }), 400, /no profile named claude-opus in repo web/);
    await refused("/api/repos/nowhere/profiles/claude-opus", put({ runner: "claude" }, true), 404, /no repo named nowhere in config\.yaml/);
    await refused("/api/repos/web/profiles/claude-opus", { method: "DELETE" }, 404, /no profile named claude-opus in repo web/);
    await refused("/api/repos/nowhere/profiles/solo", { method: "DELETE" }, 404, /no repo named nowhere/);
    // A repo's default_profile with no global to fall back on stays until another is its default.
    await refused("/api/repos/app/profiles/solo", { method: "DELETE" }, 400, /solo is repo app's default_profile; make another profile its default first/);
    await refused("/api/repos/app", { method: "PATCH", body: json({ default_profile: "nobody" }) }, 400, /no profile named nobody in config\.yaml for repo app/);
    await refused("/api/repos/web", { method: "PATCH", body: json({ default_profile: "solo" }) }, 400, /no profile named solo in config\.yaml for repo web/);
    await refused("/api/repos/app", { method: "PATCH", body: json({ path: "/elsewhere" }) }, 400, /only a repo's default_profile is set here/);
    await refused("/api/repos/nowhere", { method: "PATCH", body: json({ default_profile: "claude-opus" }) }, 404, /no repo named nowhere/);
    expect(await readFile(configPath(lasso), "utf8")).toBe(text);
  });

  it("sets and clears a repo's default_profile in place, and deletes a repo-only profile a Pipeline names only once confirmed", async () => {
    const lasso = await twoRepos({ profiles: { solo: { runner: "claude", model: "haiku" } }, default_profile: "solo" });
    await annotate(lasso);
    // Any profile app can reach: a global one, then none (config's default_profile again).
    const set = await lasso.api<ConfigFile>("/api/repos/app", { method: "PATCH", body: json({ default_profile: "claude-fable" }) });
    expect(set.config.repos.app!.default_profile).toBe("claude-fable");
    expect(set.text).toContain("# my config");
    const cleared = await lasso.api<ConfigFile>("/api/repos/app", { method: "PATCH", body: json({ default_profile: null }) });
    expect(cleared.config.repos.app!.default_profile).toBeNull();
    expect(parse(cleared.text).repos.app).not.toHaveProperty("default_profile");

    // A Pipeline naming solo would be Flagged in app with it gone, so the delete waits for confirmation.
    await lasso.api("/api/pipelines/solo", { method: "PUT", body: json({ text: ONE.replace("claude-opus", "solo"), create: true }) });
    const named = await raw(lasso, "/api/repos/app/profiles/solo", { method: "DELETE" });
    expect(named.status).toBe(409);
    expect(await named.json()).toEqual({ error: "solo is named by solo/implement; their next Sessions in repo app are Flagged once it is gone", usedBy: ["solo/implement"], confirm: true });
    const gone = await lasso.api<ConfigFile>("/api/repos/app/profiles/solo?confirm=1", { method: "DELETE" });
    expect(gone.config.repos.app!.profiles).toEqual({});
    expect(gone.text).toContain("profiles: {}");
    expect(gone.text).toContain("# my config");
  });
});
