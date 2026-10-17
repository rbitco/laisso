import { describe, it, expect } from "vitest";
import { outstanding, fresh, addressedEvidence, watermarkOf, logSlice, ownMark, marker, ignoring, withoutIgnored, type PrFacts } from "../src/review/feedback.ts";
import { splitResponse } from "../src/review/github.ts";

// Seam two, pure: the rules that turn a PR's state into Feedback items, and what counts as addressed.
const own = ownMark("01ABC", "review");
const mark = marker("01ABC", "review", 1);
const at = (m: number) => `2026-09-27T10:${String(m).padStart(2, "0")}:00Z`;

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  owner: "o", repo: "r", number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", headSha: "aaaaaaa1",
  reviewDecision: null, reviewCount: 0, reviews: [], threads: [], comments: [], inline: [], checks: [],
  ...over,
});

const thread = (resolved: boolean, comments: PrFacts["threads"][number]["comments"]) => ({ id: "RT_1", isResolved: resolved, isOutdated: false, path: "src/a.ts", line: 3, comments });
const comment = (id: number, author: string, body: string, m: number) => ({ id: String(id), author, body, createdAt: at(m), updatedAt: at(m), url: `u/${id}` });
const check = (id: number, conclusion: string | null, status = "completed") => ({ id: String(id), name: "test", status, conclusion, url: `c/${id}`, at: at(1) });

describe("outstanding", () => {
  it("lists failed checks, unresolved threads, unanswered comments, and a changes-requested verdict; skips Lasso's own marked comments", () => {
    const items = outstanding(facts({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ id: "5", state: "CHANGES_REQUESTED", author: "alice", body: "No.", url: "r/5", submittedAt: at(2) }],
      threads: [thread(false, [comment(1, "alice", "Fix", 1)]), thread(true, [comment(2, "alice", "Old", 1)]), { ...thread(false, [comment(3, "bot", `ok\n${mark}`, 1)]), id: "RT_2" }],
      comments: [comment(10, "bob", "Add docs", 1), comment(11, "bot", `Done\n${mark}`, 2), comment(12, "carol", "Later", 3)],
      checks: [check(100, "failure"), check(101, "success"), check(102, null, "in_progress"), check(103, "timed_out")],
    }), own);
    expect(items.map((i) => [i.kind, i.id, i.summary])).toEqual([
      ["check", "100", "check test failed"],
      ["check", "103", "check test failed"],
      ["thread", "RT_1", "thread on src/a.ts:3 by alice"],
      ["comment", "12", "comment by carol"],
      ["verdict", "5", "changes requested by alice"],
    ]);
    expect(items[0]!.head).toBe("aaaaaaa1");
    expect(items[2]).toMatchObject({ path: "src/a.ts", line: 3, body: "alice: Fix", url: "u/1" });
  });

  it("fresh keeps checks by id, comments and threads by time past the watermark, and never a verdict on its own", () => {
    const items = outstanding(facts({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ id: "5", state: "CHANGES_REQUESTED", author: "alice", body: "", url: "r/5", submittedAt: at(9) }],
      threads: [thread(false, [comment(1, "alice", "Fix", 1)])],
      comments: [comment(10, "bob", "Add docs", 5)],
      checks: [check(100, "failure")],
    }), own);
    const seen = { checkIds: new Set(["100"]), lastRoundChecks: new Set<string>() };
    expect(fresh(items, at(3), seen).map((i) => i.id)).toEqual(["10"]);
    expect(fresh(items, null, { checkIds: new Set(), lastRoundChecks: new Set() }).map((i) => i.id)).toEqual(["100", "RT_1", "10"]);
    expect(watermarkOf(facts({ comments: [comment(10, "bob", "x", 5)], reviews: [{ id: "5", state: "APPROVED", author: "a", body: "", url: "", submittedAt: at(8) }] }), at(2))).toBe(at(8));
  });
});

describe("addressedEvidence", () => {
  const base = outstanding(facts({
    threads: [thread(false, [comment(1, "alice", "Fix", 1)])],
    comments: [comment(10, "bob", "Add docs", 1)],
    checks: [check(100, "failure")],
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [{ id: "5", state: "CHANGES_REQUESTED", author: "alice", body: "", url: "r/5", submittedAt: at(1) }],
  }), own);
  const [checkItem, threadItem, commentItem, verdictItem] = base;

  it("a thread is addressed by resolution, a comment by a marked reply, a check by a new push, a verdict by its threads", () => {
    const later = facts({
      headSha: "bbbbbbb2",
      threads: [thread(true, [comment(1, "alice", "Fix", 1), comment(2, "bot", `done\n${mark}`, 4)])],
      comments: [comment(10, "bob", "Add docs", 1), comment(11, "bot", `done\n${mark}`, 4)],
      reviewDecision: "CHANGES_REQUESTED",
    });
    expect(addressedEvidence(threadItem!, later, own, true)).toBe("resolved after reply u/2");
    expect(addressedEvidence(commentItem!, later, own, true)).toBe("replied u/11");
    expect(addressedEvidence(checkItem!, later, own, true)).toBe("new push bbbbbbb");
    expect(addressedEvidence(verdictItem!, later, own, true)).toBe("its threads addressed");
    expect(addressedEvidence(verdictItem!, { ...later, reviewDecision: "APPROVED" }, own, false)).toBe("review decision approved");
  });

  it("pairs each marked reply with one comment, oldest first, so one reply never answers two", () => {
    const later = facts({ comments: [comment(10, "bob", "Add docs", 1), comment(11, "carol", "Rename", 2), comment(12, "bot", `done\n${mark}`, 4)] });
    const items = outstanding(later, own);
    expect(items.map((i) => i.id)).toEqual(["11"]);
    expect(addressedEvidence(commentItem!, later, own, null)).toBe("replied u/12");
    expect(addressedEvidence({ ...commentItem!, id: "11", at: at(2) }, later, own, null)).toBeNull();
  });

  it("a verdict with no threads is addressed by a marked reply after it, not by default", () => {
    expect(addressedEvidence(verdictItem!, facts({ reviewDecision: "CHANGES_REQUESTED" }), own, null)).toBeNull();
    expect(addressedEvidence(verdictItem!, facts({ reviewDecision: "CHANGES_REQUESTED", comments: [comment(20, "bot", `done\n${mark}`, 4)] }), own, null)).toBe("replied u/20");
  });

  it("is null while nothing changed", () => {
    const same = facts({ threads: [thread(false, [comment(1, "alice", "Fix", 1)])], comments: [comment(10, "bob", "Add docs", 1)], reviewDecision: "CHANGES_REQUESTED" });
    expect(base.map((i) => addressedEvidence(i, same, own, false))).toEqual([null, null, null, null]);
    // An unmarked reply from someone else is not Lasso addressing the comment.
    expect(addressedEvidence(commentItem!, facts({ comments: [comment(10, "bob", "Add docs", 1), comment(11, "carol", "+1", 4)] }), own, false)).toBeNull();
  });
});

describe("logSlice", () => {
  it("strips timestamps and cuts from the group before the first error to 20 lines after", () => {
    const lines = ["##[group]Setup", "a", "##[endgroup]", "##[group]Run tests", "b", "c", "##[error]boom", ...Array.from({ length: 30 }, (_, i) => `after ${i}`)];
    const text = lines.map((l) => `2026-09-27T10:00:00.0000000Z ${l}`).join("\n");
    const slice = logSlice(text).split("\n");
    expect(slice[0]).toBe("##[group]Run tests");
    expect(slice[3]).toBe("##[error]boom");
    expect(slice).toHaveLength(23);
    expect(slice.at(-1)).toBe("after 18");
  });

  it("falls back to the tail when no line is an error", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(logSlice(text).split("\n")).toHaveLength(40);
    expect(logSlice(text).split("\n")[0]).toBe("line 60");
  });
});

describe("splitResponse", () => {
  it("reads the status, ETag, and body of gh api -i output", () => {
    expect(splitResponse('HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nContent-Type: application/json\r\n\r\n[{"id":1}]')).toEqual({ status: 200, etag: 'W/"abc"', body: '[{"id":1}]' });
    expect(splitResponse('HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n')).toEqual({ status: 304, etag: 'W/"abc"', body: "" });
  });
});

describe("withoutIgnored", () => {
  const ignored = ignoring(["Me", "octocat"]);

  it("ignores logins whatever their case, and no one when none are given", () => {
    expect(ignored("me")).toBe(true);
    expect(ignored("OCTOCAT")).toBe(true);
    expect(ignored("alice")).toBe(false);
    expect(ignoring([])("me")).toBe(false);
  });

  it("drops comments by ignored authors, so they are never Feedback, but keeps marked replies to pair with what they answer", () => {
    const items = outstanding(withoutIgnored(facts({
      // bob asked, then me noted something, then Lasso (posting as me) answered bob.
      comments: [comment(10, "bob", "Add docs", 1), comment(11, "me", "Note to self", 2), comment(12, "me", `Done\n${mark}`, 3), comment(13, "octocat", "FYI", 4)],
    }), own, ignored), own);
    expect(items).toEqual([]);
    const unanswered = outstanding(withoutIgnored(facts({ comments: [comment(10, "bob", "Add docs", 1), comment(11, "me", "Note to self", 2)] }), own, ignored), own);
    expect(unanswered.map((i) => i.id)).toEqual(["10"]);
  });

  it("drops a thread only ignored authors asked in, and keeps a mixed one whole for the Round", () => {
    const filtered = withoutIgnored(facts({
      threads: [
        { ...thread(false, [comment(1, "me", "Context for reviewers", 1), comment(2, "bot", `ok\n${mark}`, 2)]), id: "RT_self" },
        { ...thread(false, [comment(3, "alice", "Why?", 1), comment(4, "me", "Because.", 2)]), id: "RT_mixed" },
        { ...thread(false, [comment(5, "me", "Hm", 1), comment(6, "carol", "Agreed, fix it", 2)]), id: "RT_joined" },
      ],
    }), own, ignored);
    const items = outstanding(filtered, own);
    expect(items.map((i) => i.id)).toEqual(["RT_mixed", "RT_joined"]);
    expect(items[0]!.body).toBe("alice: Why?\n\nme: Because.");
    expect(items[1]).toMatchObject({ summary: "thread on src/a.ts:3 by me", body: "me: Hm\n\ncarol: Agreed, fix it" });
  });

  it("leaves failed checks and a changes-requested verdict standing, whoever is involved", () => {
    const items = outstanding(withoutIgnored(facts({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ id: "5", state: "CHANGES_REQUESTED", author: "octocat", body: "No.", url: "r/5", submittedAt: at(2) }],
      checks: [check(100, "failure")],
    }), own, ignored), own);
    expect(items.map((i) => [i.kind, i.id])).toEqual([["check", "100"], ["verdict", "5"]]);
  });
});
