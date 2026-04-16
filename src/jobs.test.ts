import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_CWD = process.cwd();
const TEMP_DIR = join(tmpdir(), `hermes-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const JOBS_DIR = join(TEMP_DIR, ".claude", "hermes", "jobs");

// chdir happens before the first loadJobs() call; the jobs module resolves
// jobsDir() lazily at call time, so the new cwd is picked up automatically.
await mkdir(JOBS_DIR, { recursive: true });
process.chdir(TEMP_DIR);
const { loadJobs, clearJobSchedule } = await import("./jobs");

async function clearJobsDir(): Promise<void> {
  await rm(JOBS_DIR, { recursive: true, force: true });
  await mkdir(JOBS_DIR, { recursive: true });
}

beforeAll(async () => {
  await clearJobsDir();
});

afterEach(async () => {
  await clearJobsDir();
});

afterAll(async () => {
  process.chdir(ORIGINAL_CWD);
  await rm(TEMP_DIR, { recursive: true, force: true });
});

describe("loadJobs", () => {
  test("parses a valid job with all fields", async () => {
    await writeFile(
      join(JOBS_DIR, "hello.md"),
      `---\nschedule: "* * * * *"\nrecurring: true\nnotify: false\n---\nHello prompt`
    );
    const jobs = await loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      name: "hello",
      schedule: "* * * * *",
      recurring: true,
      notify: false,
      prompt: "Hello prompt",
    });
  });

  test("skips files with no frontmatter and logs an error", async () => {
    const original = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await writeFile(join(JOBS_DIR, "broken.md"), "no frontmatter here\n");
      const jobs = await loadJobs();
      expect(jobs).toHaveLength(0);
      const combined = errors.map((a) => a.join(" ")).join("\n");
      expect(combined).toContain("broken");
      expect(combined).toContain("Invalid job file format");
    } finally {
      console.error = original;
    }
  });

  test("skips jobs missing a schedule", async () => {
    await writeFile(join(JOBS_DIR, "noschedule.md"), `---\nrecurring: true\n---\nBody`);
    const jobs = await loadJobs();
    expect(jobs).toHaveLength(0);
  });

  test("treats legacy `daily: true` as recurring=true", async () => {
    await writeFile(join(JOBS_DIR, "legacy.md"), `---\nschedule: "0 9 * * *"\ndaily: true\n---\nLegacy body`);
    const jobs = await loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].recurring).toBe(true);
  });

  test('preserves notify="error" as the literal string "error"', async () => {
    await writeFile(
      join(JOBS_DIR, "errnotify.md"),
      `---\nschedule: "*/5 * * * *"\nnotify: error\n---\nPrompt`
    );
    const jobs = await loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].notify).toBe("error");
  });

  test('notify="no" becomes false; missing notify defaults to true', async () => {
    await writeFile(join(JOBS_DIR, "no.md"), `---\nschedule: "* * * * *"\nnotify: no\n---\nA`);
    await writeFile(join(JOBS_DIR, "default.md"), `---\nschedule: "* * * * *"\n---\nB`);
    const jobs = await loadJobs();
    const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
    expect(byName.no.notify).toBe(false);
    expect(byName.default.notify).toBe(true);
  });

  test("picks up multiple .md files and ignores non-.md files", async () => {
    await writeFile(join(JOBS_DIR, "a.md"), `---\nschedule: "1 * * * *"\n---\nAlpha`);
    await writeFile(join(JOBS_DIR, "b.md"), `---\nschedule: "2 * * * *"\n---\nBravo`);
    await writeFile(join(JOBS_DIR, "ignore.txt"), "not a job");
    const jobs = await loadJobs();
    const names = jobs.map((j) => j.name).sort();
    expect(names).toEqual(["a", "b"]);
  });
});

describe("clearJobSchedule", () => {
  test("removes the schedule line but keeps the rest of the frontmatter", async () => {
    const file = join(JOBS_DIR, "clearme.md");
    await writeFile(file, `---\nschedule: "* * * * *"\nrecurring: true\nnotify: error\n---\nBody text`);
    await clearJobSchedule("clearme");
    const after = await readFile(file, "utf8");
    expect(after).not.toContain("schedule:");
    expect(after).toContain("recurring: true");
    expect(after).toContain("notify: error");
    expect(after).toContain("Body text");

    const jobs = await loadJobs();
    expect(jobs).toHaveLength(0);
  });
});
