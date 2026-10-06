import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, openDb } from "../state";
import { evolveOnce } from "./loop";

for (const status of [" M", "M ", "??"]) {
  test(`dirty worktree (${status}) blocks before executor, verification, journal or Git mutations`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hermes-loop-safety-"));
    const db = openDb({ path: ":memory:" });
    try {
      await applyMigrations(db);
      await writeFile(join(cwd, "user.txt"), "user work");
      let executed = false;
      let verified = false;
      const calls: string[][] = [];
      const result = await evolveOnce(
        db,
        { id: "blocked", title: "Safe evolve", body: "Inspect fixture" },
        cwd,
        {
          runExec: async () => {
            executed = true;
            return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
          },
          gate: {
            runVerify: async () => {
              verified = true;
              return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
            },
            runGit: async (_cwd, args) => {
              calls.push(args);
              return { ok: true, stdout: args[0] === "status" ? `${status} user.txt\0` : "", stderr: "" };
            },
          },
        }
      );
      expect(result.outcome).toBe("dirty-worktree");
      expect(executed).toBe(false);
      expect(verified).toBe(false);
      expect(calls).toHaveLength(1);
      expect(await readdir(cwd)).toEqual(["user.txt"]);
      expect(db.query("SELECT count(*) AS n FROM learn_events").get()).toEqual({ n: 0 });
    } finally {
      closeDb(db);
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
