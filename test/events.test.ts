import { describe, it, expect, afterEach } from "vitest";
import { startLassoWithRepos, waitFor, type Lasso } from "./harness.ts";
import type { IntakeResult, PrListsView, TicketDetail } from "../src/api/views.ts";

// The dashboard's push channel: /api/events names what changed so the page can re-read it instead of polling.
const running: Lasso[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.destroy();
});

const PIPELINE = `stages:
  - name: implement
    prompt: Do the work.
`;

interface Event {
  event: string;
  data: Record<string, unknown>;
}

/** An open /api/events stream: every event so far, in order, parsed. */
function listen(lasso: Lasso) {
  const events: Event[] = [];
  const abort = new AbortController();
  const done = (async () => {
    const res = await fetch(`${lasso.url}/api/events`, { signal: abort.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  const seen = (what: string, match: (e: Event) => boolean) => waitFor(async () => events.find(match) ?? null, what);
  return { events, seen, done, close: () => abort.abort() };
}

async function lassoWith() {
  const started = await startLassoWithRepos({ app: { pipeline: "one" } }, {}, { one: PIPELINE });
  running.push(started.lasso);
  return started.lasso;
}

const admit = (lasso: Lasso) => lasso.api<IntakeResult>("/api/tickets", { method: "POST", body: JSON.stringify({ input: "Add dark mode", repo: "app", pipeline: "one" }) });

describe("the event stream", () => {
  it("names the Ticket when a running Session's Latest Message changes", async () => {
    const lasso = await lassoWith();
    const ticket = await admit(lasso);
    const stream = listen(lasso);
    await stream.seen("hello", (e) => e.event === "hello");
    await lasso.runner.script({ stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] }, parent_tool_use_id: null }), delayMs: 500, hang: true });
    await lasso.api("/api/check-now", { method: "POST" });
    const out = await stream.seen("stdout", (e) => e.event === "stdout" && e.data.ticket === ticket.id);
    await stream.seen("the Ticket after stdout", (e) => stream.events.indexOf(e) > stream.events.indexOf(out) && e.event === "ticket" && e.data.ticket === ticket.id);
    const d = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}`);
    expect(d.session!.latestMessage).toBe("On it.");
    stream.close();
  });

  it("says hello with the tick status, then names each Ticket that changed, a burst of writes as one event", async () => {
    const lasso = await lassoWith();
    const stream = listen(lasso);
    const hello = await stream.seen("hello", (e) => e.event === "hello");
    expect(hello.data).toMatchObject({ tickSeconds: expect.any(Number), running: false });

    // Intake writes the row several times (insert, pin, mirror); the stream sends one "ticket" for it.
    const ticket = await admit(lasso);
    await stream.seen("the new Ticket", (e) => e.event === "ticket" && e.data.ticket === ticket.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(stream.events.filter((e) => e.event === "ticket")).toEqual([{ event: "ticket", data: { ticket: ticket.id } }]);

    // Check now: the tick is announced with its status, and the Session it starts changes the Ticket again.
    await lasso.runner.script({ stdout: '{"type":"system","subtype":"init","session_id":"x"}\n', hang: true });
    const before = stream.events.length;
    await lasso.api("/api/check-now", { method: "POST" });
    await stream.seen("a tick", (e) => stream.events.indexOf(e) >= before && e.event === "tick");
    await stream.seen("the Ticket again", (e) => stream.events.indexOf(e) >= before && e.event === "ticket");

    // The Runner's stdout: named by Session, so the page reads it from its offset.
    const d = await waitFor(async () => { const x = await lasso.api<TicketDetail>(`/api/tickets/${ticket.id}`); return x.session?.running ? x : null; }, "the Session to start");
    await stream.seen("stdout", (e) => e.event === "stdout" && e.data.session === d.session!.id && e.data.ticket === ticket.id);
    stream.close();
  });

  it("ends open streams at shutdown, so Ctrl-C still exits at once", async () => {
    const lasso = await lassoWith();
    const stream = listen(lasso);
    await stream.seen("hello", (e) => e.event === "hello");
    const started = Date.now();
    const stopped = lasso.stop();
    await stream.done;
    expect(await stopped).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("names config after an edit through the API, so an open Config page reads it again", async () => {
    const lasso = await lassoWith();
    const stream = listen(lasso);
    await stream.seen("hello", (e) => e.event === "hello");
    await lasso.api("/api/config", { method: "PATCH", body: JSON.stringify({ concurrency: 4 }) });
    await stream.seen("config after a settings save", (e) => e.event === "config");
    const before = stream.events.length;
    await lasso.api("/api/profiles/claude-haiku", { method: "PUT", body: JSON.stringify({ profile: { runner: "claude", model: "haiku" }, create: true }) });
    await stream.seen("config after a profile save", (e) => e.event === "config" && stream.events.indexOf(e) >= before);
    stream.close();
  });

  it("names each Pipeline created, edited or deleted through the API, so an open Pipelines page reads its list again", async () => {
    const lasso = await lassoWith();
    const stream = listen(lasso);
    await stream.seen("hello", (e) => e.event === "hello");
    const after = (n: number) => (e: Event) => stream.events.indexOf(e) >= n;
    let before = stream.events.length;
    await lasso.api("/api/pipelines/two", { method: "PUT", body: JSON.stringify({ text: PIPELINE, create: true }) });
    await stream.seen("pipeline after a create", (e) => after(before)(e) && e.event === "pipeline" && e.data.pipeline === "two");
    before = stream.events.length;
    await lasso.api("/api/pipelines/two", { method: "PATCH", body: JSON.stringify({ stages: { implement: { prompt: "Do it well." } } }) });
    await stream.seen("pipeline after a patch", (e) => after(before)(e) && e.event === "pipeline" && e.data.pipeline === "two");
    before = stream.events.length;
    await lasso.api("/api/pipelines/two", { method: "DELETE" });
    await stream.seen("pipeline after a delete", (e) => after(before)(e) && e.event === "pipeline" && e.data.pipeline === "two");
    stream.close();
  });

  it("names prlists as a PR List starts and finishes fetching, and a read does not wait for the fetch", async () => {
    const { lasso } = await startLassoWithRepos({}, { pr_lists: { Example: { query: "is:open org:example", limit: 5 } } });
    running.push(lasso);
    const body = { data: { rateLimit: { cost: 1, remaining: 4900, resetAt: "2026-10-15T13:00:00Z" }, search: { issueCount: 0, nodes: [] } } };
    await lasso.tracker.reply({ tool: "gh", match: ["api graphql", "org:example"], stdout: JSON.stringify(body), sleepMs: 300 });
    const stream = listen(lasso);
    await stream.seen("hello", (e) => e.event === "hello");
    const first = await lasso.api<PrListsView>("/api/pr-lists");
    expect(first.lists.map((l) => [l.name, l.fetching, l.fetchedAt])).toEqual([["Example", true, null]]);
    // The search takes longer than the stream gathers changes, so its start and end go out as two events.
    const started = await stream.seen("prlists as the fetch starts", (e) => e.event === "prlists");
    await stream.seen("prlists as it finishes", (e) => e.event === "prlists" && e !== started);
    const after = await lasso.api<PrListsView>("/api/pr-lists");
    expect(after.lists.map((l) => [l.fetching, l.fetchedAt !== null, l.error])).toEqual([[false, true, null]]);
    stream.close();
  });
});
