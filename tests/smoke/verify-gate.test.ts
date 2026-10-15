import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("normal verification unit step includes verify's own tests without recursive verification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-verify-gate-"));
  try {
    const bin = join(cwd, "bin");
    await mkdir(bin);
    const fakeBun = `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
`;
    await writeFile(join(bin, "bun"), fakeBun);
    await chmod(join(bin, "bun"), 0o755);
    // Only inspect the real unit command. The fake child never executes tests.
    const child = Bun.spawn(
      [process.execPath, "run", resolve("scripts/verify.ts"), "--only=unit", "--json"],
      {
        cwd,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).results.map((result: { name: string }) => result.name)).toEqual(["unit"]);
    const calls = (await readFile(join(cwd, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("test");
    expect(calls[0]).toContain("src");
    expect(calls[0]).toContain("scripts/verify.test.ts");
    expect(calls[0]).not.toContain("scripts");
    expect(calls[0]).not.toContain("verify");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
