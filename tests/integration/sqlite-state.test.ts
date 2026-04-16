import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyMigrations,
  closeDb,
  eventsRepo,
  jobsRepo,
  memoryRepo,
  messagesRepo,
  openDb,
  policiesRepo,
  sessionsRepo,
  skillRunsRepo,
  skillsRepo,
  type Database,
} from "../../src/state";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

describe("schema", () => {
  test("migrations recorded in schema_migrations", () => {
    const rows = db
      .query<{ version: string }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    expect(rows.map((r) => r.version)).toContain("001_init");
  });

  test("second applyMigrations is a no-op", async () => {
    const applied = await applyMigrations(db);
    expect(applied).toEqual([]);
  });
});

describe("sessions repo", () => {
  test("upsert + getByKey round-trip", () => {
    const s = sessionsRepo.upsertSession(db, {
      key: "dm:alice",
      scope: "per-user",
      source: "discord",
      workspace: "/tmp/proj",
      user: "alice",
    });
    expect(s.id).toBeGreaterThan(0);
    expect(s.turn_count).toBe(0);

    const again = sessionsRepo.getByKey(db, "dm:alice");
    expect(again?.id).toBe(s.id);
  });

  test("bumpTurn increments", () => {
    const s = sessionsRepo.upsertSession(db, {
      key: "dm:bob",
      scope: "per-user",
      source: "discord",
      workspace: "/tmp/proj",
    });
    sessionsRepo.bumpTurn(db, s.id);
    sessionsRepo.bumpTurn(db, s.id);
    const after = sessionsRepo.getById(db, s.id);
    expect(after?.turn_count).toBe(2);
  });
});

describe("messages + FTS", () => {
  test("insert then full-text search", () => {
    const s = sessionsRepo.upsertSession(db, {
      key: "fts:test",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/proj",
    });
    messagesRepo.appendMessage(db, { sessionId: s.id, role: "user", content: "deploy the gateway" });
    messagesRepo.appendMessage(db, { sessionId: s.id, role: "assistant", content: "gateway shipped" });
    messagesRepo.appendMessage(db, { sessionId: s.id, role: "user", content: "unrelated chatter" });

    const hits = messagesRepo.search(db, "gateway");
    expect(hits.length).toBe(2);
    expect(hits[0]?.sessionKey).toBe("fts:test");
    expect(hits[0]?.snippet).toContain("[gateway]");
  });

  test("scope filter restricts FTS hits", () => {
    sessionsRepo.upsertSession(db, {
      key: "fts:other",
      scope: "per-user",
      source: "telegram",
      workspace: "/tmp/proj",
    });
    const other = sessionsRepo.getByKey(db, "fts:other")!;
    messagesRepo.appendMessage(db, { sessionId: other.id, role: "user", content: "telegram gateway" });

    const workspaceHits = messagesRepo.search(db, "gateway", { scope: "workspace" });
    const dmHits = messagesRepo.search(db, "gateway", { scope: "per-user" });
    expect(workspaceHits.every((h) => h.sessionKey === "fts:test")).toBe(true);
    expect(dmHits.every((h) => h.sessionKey === "fts:other")).toBe(true);
  });
});

describe("policies repo", () => {
  test("upsert/get/list", () => {
    policiesRepo.upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { mode: "listen" });
    const fetched = policiesRepo.getPolicy<{ mode: string }>(db, {
      source: "discord",
      guild: "g1",
      channel: "c1",
    });
    expect(fetched?.mode).toBe("listen");

    policiesRepo.upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { mode: "mention" });
    const updated = policiesRepo.getPolicy<{ mode: string }>(db, {
      source: "discord",
      guild: "g1",
      channel: "c1",
    });
    expect(updated?.mode).toBe("mention");
  });
});

describe("memory repo", () => {
  test("insert + filter by scope", () => {
    memoryRepo.insertMemory(db, { scope: "user", key: "fav-color", value: "indigo" });
    memoryRepo.insertMemory(db, { scope: "channel", key: "topic", value: "ops" });

    const userOnly = memoryRepo.listMemory(db, { scope: "user" });
    expect(userOnly.every((r) => r.scope === "user")).toBe(true);
  });

  test("expired entries hidden", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    memoryRepo.insertMemory(db, { scope: "user", key: "old", value: "x", expiresAt: past });
    const visible = memoryRepo.listMemory(db, { scope: "user", key: "old" });
    expect(visible.length).toBe(0);
  });
});

describe("skills + runs", () => {
  test("upsert skill → record runs → stats", () => {
    skillsRepo.upsertSkill(db, { name: "summarise", path: "/tmp/summarise/SKILL.md" });
    const runId = skillRunsRepo.startRun(db, { skillName: "summarise", version: 1 });
    skillRunsRepo.finishRun(db, { id: runId, success: true, turnsSaved: 1.5 });

    const stats = skillRunsRepo.statsFor(db, "summarise", 7);
    expect(stats.runs).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.avgTurnsSaved).toBeGreaterThan(0);
  });

  test("status transitions stamp promoted_at only for active", () => {
    skillsRepo.upsertSkill(db, { name: "rebase", path: "/tmp/rebase/SKILL.md" });
    skillsRepo.setStatus(db, "rebase", "active");
    expect(skillsRepo.getSkill(db, "rebase")?.promoted_at).not.toBeNull();

    skillsRepo.setStatus(db, "rebase", "disabled");
    expect(skillsRepo.getSkill(db, "rebase")?.status).toBe("disabled");
  });
});

describe("jobs repo", () => {
  test("upsert + prune", () => {
    jobsRepo.upsertJob(db, { name: "daily", path: "jobs/daily.md", schedule: "0 9 * * *" });
    jobsRepo.upsertJob(db, {
      name: "hourly",
      path: "jobs/hourly.md",
      schedule: "0 * * * *",
      recurring: true,
    });
    expect(jobsRepo.listJobs(db).length).toBeGreaterThanOrEqual(2);

    jobsRepo.pruneMissing(db, ["daily"]);
    expect(jobsRepo.getJob(db, "hourly")).toBeNull();
  });
});

describe("events repo (journal substrate)", () => {
  test("append + filter by kind prefix", () => {
    eventsRepo.appendEvent(db, "skill.promote", { name: "summarise" });
    eventsRepo.appendEvent(db, "skill.demote", { name: "rebase" });
    eventsRepo.appendEvent(db, "evolve.plan", { target: "router" });

    const skillEvents = eventsRepo.listEvents(db, { kindPrefix: "skill." });
    expect(skillEvents.length).toBe(2);
    expect(skillEvents.every((e) => e.kind.startsWith("skill."))).toBe(true);
  });
});
