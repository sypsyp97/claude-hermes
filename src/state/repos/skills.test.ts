import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { startRun } from "./skillRuns";
import { getSkill, latestVersion, listSkills, recordVersion, setStatus, upsertSkill } from "./skills";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM skill_runs");
  db.exec("DELETE FROM skill_versions");
  db.exec("DELETE FROM skills");
});

describe("upsertSkill", () => {
  test("inserts with default status=candidate and empty json arrays", () => {
    const row = upsertSkill(db, { name: "summarise", path: "/tmp/summarise/SKILL.md" });
    expect(row.name).toBe("summarise");
    expect(row.path).toBe("/tmp/summarise/SKILL.md");
    expect(row.status).toBe("candidate");
    expect(JSON.parse(row.trigger_tags_json)).toEqual([]);
    expect(JSON.parse(row.allowed_tools_json)).toEqual([]);
    expect(row.promoted_at).toBeNull();
    expect(row.promoted_at_run_id).toBeNull();
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("stores status, triggerTags, allowedTools when provided", () => {
    const row = upsertSkill(db, {
      name: "rebase",
      path: "/tmp/rebase/SKILL.md",
      status: "shadow",
      triggerTags: ["git", "merge"],
      allowedTools: ["Bash", "Read"],
    });
    expect(row.status).toBe("shadow");
    expect(JSON.parse(row.trigger_tags_json)).toEqual(["git", "merge"]);
    expect(JSON.parse(row.allowed_tools_json)).toEqual(["Bash", "Read"]);
  });

  test("upsert on existing name updates path/tags/tools but not status", () => {
    upsertSkill(db, {
      name: "s",
      path: "/old",
      status: "shadow",
      triggerTags: ["a"],
      allowedTools: ["X"],
    });
    const updated = upsertSkill(db, {
      name: "s",
      path: "/new",
      status: "active",
      triggerTags: ["b"],
      allowedTools: ["Y", "Z"],
    });
    expect(updated.path).toBe("/new");
    expect(JSON.parse(updated.trigger_tags_json)).toEqual(["b"]);
    expect(JSON.parse(updated.allowed_tools_json)).toEqual(["Y", "Z"]);
    // Status is only mutated via setStatus.
    expect(updated.status).toBe("shadow");
  });

  test("status CHECK constraint rejects invalid values at insert time", () => {
    expect(() => {
      db.prepare("INSERT INTO skills (name, path, status, created_at) VALUES (?, ?, ?, ?)").run(
        "bad",
        "/tmp",
        "bogus-status",
        "2024-01-01T00:00:00.000Z"
      );
    }).toThrow();
  });
});

describe("getSkill", () => {
  test("returns null for unknown name", () => {
    expect(getSkill(db, "ghost")).toBeNull();
  });

  test("returns the stored row", () => {
    upsertSkill(db, { name: "k", path: "/tmp/k" });
    expect(getSkill(db, "k")?.name).toBe("k");
  });
});

describe("listSkills", () => {
  test("empty db returns []", () => {
    expect(listSkills(db)).toEqual([]);
  });

  test("without status filter returns all rows by name ASC", () => {
    upsertSkill(db, { name: "charlie", path: "/c" });
    upsertSkill(db, { name: "alpha", path: "/a" });
    upsertSkill(db, { name: "bravo", path: "/b" });
    expect(listSkills(db).map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("status filter narrows to matching rows", () => {
    upsertSkill(db, { name: "s1", path: "/p1", status: "shadow" });
    upsertSkill(db, { name: "s2", path: "/p2", status: "shadow" });
    upsertSkill(db, { name: "a1", path: "/pa", status: "active" });
    upsertSkill(db, { name: "c1", path: "/pc", status: "candidate" });
    upsertSkill(db, { name: "d1", path: "/pd", status: "disabled" });

    expect(
      listSkills(db, "shadow")
        .map((r) => r.name)
        .sort()
    ).toEqual(["s1", "s2"]);
    expect(listSkills(db, "active").map((r) => r.name)).toEqual(["a1"]);
    expect(listSkills(db, "candidate").map((r) => r.name)).toEqual(["c1"]);
    expect(listSkills(db, "disabled").map((r) => r.name)).toEqual(["d1"]);
  });
});

describe("setStatus", () => {
  test("promote=true stamps promoted_at and max run id observed", () => {
    upsertSkill(db, { name: "k", path: "/tmp/k" });
    startRun(db, { skillName: "k", version: 1 });
    startRun(db, { skillName: "k", version: 1 });
    const lastRunId = startRun(db, { skillName: "k", version: 1 });

    setStatus(db, "k", "active");
    const row = getSkill(db, "k");
    expect(row?.status).toBe("active");
    expect(row?.promoted_at).not.toBeNull();
    expect(row?.promoted_at_run_id).toBe(lastRunId);
  });

  test("promote=true with no prior runs falls back to 0", () => {
    upsertSkill(db, { name: "fresh", path: "/tmp/fresh" });
    setStatus(db, "fresh", "active");
    expect(getSkill(db, "fresh")?.promoted_at_run_id).toBe(0);
  });

  test("promote=false leaves promoted_at untouched on further transitions", () => {
    upsertSkill(db, { name: "p", path: "/tmp/p" });
    setStatus(db, "p", "active");
    const firstStamp = getSkill(db, "p")?.promoted_at;
    expect(firstStamp).not.toBeNull();

    // Demote → promote=false by default for non-active status.
    setStatus(db, "p", "shadow");
    const afterDemote = getSkill(db, "p");
    expect(afterDemote?.status).toBe("shadow");
    expect(afterDemote?.promoted_at).toBe(firstStamp ?? null);
  });

  test("setStatus(status='disabled') does not touch promotion columns", () => {
    upsertSkill(db, { name: "d", path: "/tmp/d" });
    setStatus(db, "d", "disabled");
    const row = getSkill(db, "d");
    expect(row?.status).toBe("disabled");
    expect(row?.promoted_at).toBeNull();
    expect(row?.promoted_at_run_id).toBeNull();
  });

  test("explicit promote=true for non-active status still stamps", () => {
    upsertSkill(db, { name: "x", path: "/tmp/x" });
    setStatus(db, "x", "shadow", true);
    const row = getSkill(db, "x");
    expect(row?.status).toBe("shadow");
    expect(row?.promoted_at).not.toBeNull();
  });

  test("explicit promote=false for 'active' skips the stamp", () => {
    upsertSkill(db, { name: "np", path: "/tmp/np" });
    setStatus(db, "np", "active", false);
    const row = getSkill(db, "np");
    expect(row?.status).toBe("active");
    expect(row?.promoted_at).toBeNull();
  });

  test("re-promoting a skill updates promoted_at_run_id to latest run id", () => {
    upsertSkill(db, { name: "re", path: "/tmp/re" });
    const firstRun = startRun(db, { skillName: "re", version: 1 });
    setStatus(db, "re", "active");
    expect(getSkill(db, "re")?.promoted_at_run_id).toBe(firstRun);

    setStatus(db, "re", "shadow"); // demote — leaves promoted_at_run_id alone.
    const moreRun = startRun(db, { skillName: "re", version: 1 });
    setStatus(db, "re", "active"); // re-promote → picks up the new max.
    expect(getSkill(db, "re")?.promoted_at_run_id).toBe(moreRun);
  });
});

describe("recordVersion + latestVersion", () => {
  test("latestVersion returns 0 when no versions are recorded", () => {
    upsertSkill(db, { name: "v", path: "/tmp/v" });
    expect(latestVersion(db, "v")).toBe(0);
  });

  test("records a version row", () => {
    upsertSkill(db, { name: "v", path: "/tmp/v" });
    recordVersion(db, { skillName: "v", version: 1, skillMd: "# body", skillYaml: "name: v" });
    const row = db
      .query<{ version: number; skill_md: string | null; skill_yaml: string | null }, [string]>(
        "SELECT version, skill_md, skill_yaml FROM skill_versions WHERE skill_name = ?"
      )
      .get("v");
    expect(row?.version).toBe(1);
    expect(row?.skill_md).toBe("# body");
    expect(row?.skill_yaml).toBe("name: v");
  });

  test("latestVersion returns MAX(version) across versions", () => {
    upsertSkill(db, { name: "v2", path: "/tmp/v2" });
    recordVersion(db, { skillName: "v2", version: 1 });
    recordVersion(db, { skillName: "v2", version: 3 });
    recordVersion(db, { skillName: "v2", version: 2 });
    expect(latestVersion(db, "v2")).toBe(3);
  });

  test("INSERT OR REPLACE semantics overwrite the same (skill, version) pair", () => {
    upsertSkill(db, { name: "v3", path: "/tmp/v3" });
    recordVersion(db, { skillName: "v3", version: 1, skillMd: "old" });
    recordVersion(db, { skillName: "v3", version: 1, skillMd: "new" });
    const row = db
      .query<{ skill_md: string | null }, [string, number]>(
        "SELECT skill_md FROM skill_versions WHERE skill_name = ? AND version = ?"
      )
      .get("v3", 1);
    expect(row?.skill_md).toBe("new");

    // Still only one row for this version.
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = ?")
      .get("v3");
    expect(count?.n).toBe(1);
  });

  test("ON DELETE CASCADE removes versions when skill is deleted", () => {
    upsertSkill(db, { name: "casc", path: "/tmp/c" });
    recordVersion(db, { skillName: "casc", version: 1 });
    db.prepare("DELETE FROM skills WHERE name = ?").run("casc");
    expect(latestVersion(db, "casc")).toBe(0);
  });
});
