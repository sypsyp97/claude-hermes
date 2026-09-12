import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSessionFile, projectSlugFromCwd } from "./claude-paths";
import { downloadBytes } from "./http";
let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});
test("Claude project slugs normalize dots and spaces", () => {
  expect(projectSlugFromCwd("/tmp/my.project name")).toBe("-tmp-my-project-name");
});
test("session lookup prefers its workspace, then newest exact UUID after a move", async () => {
  home = await mkdtemp(join(tmpdir(), "hermes-transcripts-"));
  const id = "12345678-1234-4234-8234-123456789012";
  for (const name of ["-current", "-old", "-other"]) {
    await mkdir(join(home, ".claude/projects", name), { recursive: true });
    await writeFile(join(home, ".claude/projects", name, `${id}.jsonl`), "{}");
  }
  expect(await findSessionFile(home, "/current", id)).toContain("-current");
  await utimes(join(home, ".claude/projects/-old", `${id}.jsonl`), new Date(0), new Date(0));
  expect(await findSessionFile(home, "/moved", id)).not.toContain("-old");
  expect(await findSessionFile(home, "/current", "../escape")).toBeNull();
});
test("attachment download enforces actual streamed bytes without trusting Content-Length", async () => {
  let cancelled = false;
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  await expect(downloadBytes("https://example.test/file", { fetch: fetcher, maxBytes: 10 })).rejects.toThrow(
    "limit"
  );
  expect(cancelled).toBe(true);
});
