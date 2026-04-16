import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { deletePolicy, getPolicy, listPolicies, upsertPolicy } from "./policies";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM channel_policies");
});

describe("upsertPolicy", () => {
  test("inserts and returns a row with normalised guild", () => {
    const row = upsertPolicy(db, { source: "discord", channel: "c1" }, { mode: "listen" });
    expect(row.source).toBe("discord");
    expect(row.channel).toBe("c1");
    expect(row.guild).toBe("");
    expect(JSON.parse(row.policy_json)).toEqual({ mode: "listen" });
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("normalises null/undefined guild to empty string", () => {
    upsertPolicy(db, { source: "discord", guild: null, channel: "c1" }, { mode: "a" });
    upsertPolicy(db, { source: "telegram", guild: undefined, channel: "c2" }, { mode: "b" });

    const rows = db
      .query<{ source: string; guild: string; channel: string }, []>(
        "SELECT source, guild, channel FROM channel_policies ORDER BY source"
      )
      .all();
    expect(rows.map((r) => r.guild)).toEqual(["", ""]);
  });

  test("preserves an explicit guild id", () => {
    upsertPolicy(db, { source: "discord", guild: "g42", channel: "c1" }, { mode: "mention" });
    const rows = listPolicies(db, "discord");
    expect(rows[0].guild).toBe("g42");
  });

  test("upsert on same (source,guild,channel) replaces policy_json", () => {
    upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { mode: "listen" });
    upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { mode: "mention", extra: 42 });

    const rows = listPolicies(db, "discord");
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].policy_json)).toEqual({ mode: "mention", extra: 42 });
  });

  test("distinct combinations on the composite PK are independent rows", () => {
    upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { n: 1 });
    upsertPolicy(db, { source: "discord", guild: "g1", channel: "c2" }, { n: 2 });
    upsertPolicy(db, { source: "discord", guild: "g2", channel: "c1" }, { n: 3 });
    upsertPolicy(db, { source: "telegram", guild: "g1", channel: "c1" }, { n: 4 });

    expect(listPolicies(db).length).toBe(4);
  });

  test("empty-string guild does not collide with 'real' guild keys", () => {
    upsertPolicy(db, { source: "discord", channel: "c1" }, { mode: "dm" });
    upsertPolicy(db, { source: "discord", guild: "g1", channel: "c1" }, { mode: "server" });

    expect(getPolicy<{ mode: string }>(db, { source: "discord", channel: "c1" })?.mode).toBe("dm");
    expect(getPolicy<{ mode: string }>(db, { source: "discord", guild: "g1", channel: "c1" })?.mode).toBe(
      "server"
    );
  });

  test("stores arbitrary JSON policy shapes round-tripping cleanly", () => {
    const complex = {
      mode: "free-response",
      allowedSkills: ["summarise", "rebase"],
      nested: { model: "opus-4", fallback: null },
      autoThread: false,
    };
    upsertPolicy(db, { source: "discord", channel: "c" }, complex);
    expect(getPolicy<typeof complex>(db, { source: "discord", channel: "c" })).toEqual(complex);
  });
});

describe("getPolicy", () => {
  test("returns null when row does not exist", () => {
    expect(getPolicy(db, { source: "discord", channel: "ghost" })).toBeNull();
  });

  test("matches normalised guild on lookup", () => {
    upsertPolicy(db, { source: "discord", channel: "c1" }, { mode: "a" });
    // Both null and undefined should resolve to "" and find the row.
    expect(getPolicy(db, { source: "discord", guild: null, channel: "c1" })).not.toBeNull();
    expect(getPolicy(db, { source: "discord", guild: undefined, channel: "c1" })).not.toBeNull();
    expect(getPolicy(db, { source: "discord", channel: "c1" })).not.toBeNull();
  });
});

describe("listPolicies", () => {
  test("empty db returns []", () => {
    expect(listPolicies(db)).toEqual([]);
  });

  test("without source filter returns all rows ordered by updated_at DESC", () => {
    // Insert with explicit timestamps to control ordering.
    db.prepare(
      "INSERT INTO channel_policies (source, guild, channel, policy_json, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("discord", "", "c1", "{}", "2024-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO channel_policies (source, guild, channel, policy_json, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("telegram", "", "c2", "{}", "2024-06-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO channel_policies (source, guild, channel, policy_json, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("web", "", "c3", "{}", "2024-12-01T00:00:00.000Z");

    const rows = listPolicies(db);
    expect(rows.map((r) => r.source)).toEqual(["web", "telegram", "discord"]);
  });

  test("source filter narrows to matching source", () => {
    upsertPolicy(db, { source: "discord", channel: "c1" }, { n: 1 });
    upsertPolicy(db, { source: "discord", channel: "c2" }, { n: 2 });
    upsertPolicy(db, { source: "telegram", channel: "c1" }, { n: 3 });

    const discord = listPolicies(db, "discord");
    expect(discord.length).toBe(2);
    expect(discord.every((r) => r.source === "discord")).toBe(true);

    const telegram = listPolicies(db, "telegram");
    expect(telegram.length).toBe(1);

    const none = listPolicies(db, "web");
    expect(none).toEqual([]);
  });
});

describe("deletePolicy", () => {
  test("deletes an existing row and reports true", () => {
    upsertPolicy(db, { source: "discord", guild: "g", channel: "c" }, { n: 1 });
    expect(deletePolicy(db, { source: "discord", guild: "g", channel: "c" })).toBe(true);
    expect(getPolicy(db, { source: "discord", guild: "g", channel: "c" })).toBeNull();
  });

  test("returns false when no row matches", () => {
    expect(deletePolicy(db, { source: "discord", channel: "absent" })).toBe(false);
  });

  test("normalises guild for deletion", () => {
    upsertPolicy(db, { source: "discord", channel: "c" }, { n: 1 });
    expect(deletePolicy(db, { source: "discord", guild: null, channel: "c" })).toBe(true);
  });
});
