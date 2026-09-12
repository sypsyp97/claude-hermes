import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function workflow() {
  return Bun.YAML.parse(readFileSync(resolve(".github/workflows/release.yml"), "utf8")) as any;
}

async function publish(versions: string[], existing?: unknown, notes?: string, tagCommit?: string) {
  const created: any[] = [];
  const files: Record<string, unknown> = {
    "package.json": { version: versions[0] },
    ".claude-plugin/plugin.json": { version: versions[1] },
    ".claude-plugin/marketplace.json": { plugins: [{ version: versions[2] }] },
  };
  const api = {
    getReleaseByTag: async () => {
      if (existing instanceof Error) throw existing;
      if (existing) return { data: existing };
      throw Object.assign(new Error("Not Found"), { status: 404 });
    },
    createRelease: async (args: unknown) => {
      created.push(args);
      return { data: { html_url: "https://github.com/owner/repo/releases/tag/v1.0.3" } };
    },
  };
  const script = workflow().jobs.publish.steps.find((step: any) => step.with?.script).with.script;
  const run = new Function("github", "context", "core", "require", `return (async () => {${script}\n})();`);
  await run(
    {
      rest: {
        repos: api,
        git: {
          getRef: async () => {
            if (!tagCommit) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: { object: { type: "tag", sha: "annotated-tag" } } };
          },
          getTag: async () => ({ data: { object: { type: "commit", sha: tagCommit } } }),
        },
      },
    },
    { repo: { owner: "owner", repo: "repo" }, sha: "tested-sha", ref: "refs/heads/main" },
    { info() {} },
    () => ({
      readFileSync: (path: string) =>
        path.startsWith("docs/releases/") ? notes : JSON.stringify(files[path]),
      existsSync: () => notes !== undefined,
    })
  );
  return created;
}

test("release publication waits for the reusable verification matrix", () => {
  const release = workflow();
  const verify = Bun.YAML.parse(readFileSync(".github/workflows/verify.yml", "utf8")) as any;
  expect(release.on.push.branches).toEqual(["main"]);
  expect(release.on.push.paths).toContain("package.json");
  expect(release.jobs.publish.if).toBe("github.ref == 'refs/heads/main'");
  expect(release.jobs.verify.uses).toBe("./.github/workflows/verify.yml");
  expect(verify.on).toHaveProperty("workflow_call");
  expect(release.jobs.publish.needs).toBe("verify");
  expect(release.permissions.contents).toBe("read");
  expect(release.jobs.publish.permissions.contents).toBe("write");
});

test("release creation targets the verified tag commit", async () => {
  const created = await publish(["1.0.3", "1.0.3", "1.0.3"]);
  expect(created).toEqual([
    expect.objectContaining({
      tag_name: "v1.0.3",
      target_commitish: "tested-sha",
      generate_release_notes: true,
      draft: false,
      prerelease: false,
    }),
  ]);
});

test("release rejects mismatched manifest versions before publication", async () => {
  await expect(publish(["1.0.3", "1.0.2", "1.0.3"])).rejects.toThrow("version");
});

test("release rejects invalid manifest versions", async () => {
  await expect(publish(["invalid", "invalid", "invalid"])).rejects.toThrow("version");
});

test("release reruns preserve an existing release", async () => {
  expect(await publish(["1.0.3", "1.0.3", "1.0.3"], { id: 1 })).toEqual([]);
});

test("release lookup authorization errors are not treated as missing releases", async () => {
  await expect(
    publish(["1.0.3", "1.0.3", "1.0.3"], Object.assign(new Error("Forbidden"), { status: 403 }))
  ).rejects.toThrow("Forbidden");
});

test("release includes the version-specific upgrade notes", async () => {
  const created = await publish(["1.0.3", "1.0.3", "1.0.3"], undefined, "Requires Claude Code 2.1.257+");
  expect(created[0].body).toBe("Requires Claude Code 2.1.257+");
});

test("release refuses an existing tag targeting an unverified commit", async () => {
  await expect(publish(["1.0.3", "1.0.3", "1.0.3"], undefined, undefined, "other-sha")).rejects.toThrow(
    "commit"
  );
});

test("release accepts an annotated tag targeting the verified commit", async () => {
  expect(await publish(["1.0.3", "1.0.3", "1.0.3"], undefined, undefined, "tested-sha")).toHaveLength(1);
});
