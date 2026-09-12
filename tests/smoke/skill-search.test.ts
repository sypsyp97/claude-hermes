import { expect, test } from "bun:test";
import { join } from "node:path";
const script = join(import.meta.dir, "../../skills/install-skill/search.mjs");
async function search(status: number, data: unknown) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    process.argv = ["bun", ${JSON.stringify(script)}, "code review"];
    globalThis.fetch = async (url) => {
      if (!String(url).includes("/api/search?q=code%20review")) throw new Error("Expected structured search API");
      return new Response(JSON.stringify(${JSON.stringify(data)}), {status: ${status}});
    };
    await import(${JSON.stringify(script)});
  `,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  return { code: await child.exited, output: JSON.parse(await new Response(child.stdout).text()) };
}
test("skill search reads structured results and ranks by installs", async () => {
  const result = await search(200, {
    skills: [
      { source: "org/repo", skillId: "review", name: "Review", installs: 2 },
      { source: "org/popular", skillId: "code", name: "Code", installs: 10 },
    ],
  });
  expect(result.code).toBe(0);
  expect(result.output.map((s: { id: string }) => s.id)).toEqual(["code", "review"]);
});
test("skill search surfaces HTTP failure as an error", async () => {
  const result = await search(503, { error: "down" });
  expect(result.code).toBe(1);
  expect(result.output.error).toContain("503");
});
