import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractSendFileDirectives, prepareArtifact, artifactDirectory } from "./artifacts";
let cwd: string;
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
test("outbound directives are removed and duplicate paths sent only once", () => {
  expect(extractSendFileDirectives("Here [send-file:/out/a.txt] [send-file:/out/a.txt]")).toEqual({
    cleanedText: "Here",
    filePaths: ["/out/a.txt"],
  });
});
test("artifacts stay inside the session outbox including symlink resolution", async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-artifact-"));
  const root = artifactDirectory(cwd, "session-a");
  await mkdir(root, { recursive: true });
  const file = join(root, "report.txt");
  await writeFile(file, "report");
  expect((await prepareArtifact(file, root)).name).toBe("report.txt");
  await writeFile(join(cwd, "private.txt"), "secret");
  await symlink(join(cwd, "private.txt"), join(root, "escape.txt"));
  await expect(prepareArtifact(join(root, "escape.txt"), root)).rejects.toThrow("outbox");
  await expect(prepareArtifact(file, artifactDirectory(cwd, "session-b"))).rejects.toThrow();
  await expect(prepareArtifact(file, root, 2)).rejects.toThrow("limit");
});

test("an outbox root symlink cannot alias another conversation", async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-artifact-"));
  const a = artifactDirectory(cwd, "a");
  const b = artifactDirectory(cwd, "b");
  await mkdir(b, { recursive: true });
  await writeFile(join(b, "secret.txt"), "private");
  await symlink(b, a);
  await expect(prepareArtifact(join(a, "secret.txt"), a)).rejects.toThrow("outbox");
});
