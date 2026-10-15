import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeSkillFromTrajectory } from "../../src/learning/closed-loop";
import { captureCandidateSkill } from "../../src/learning/completion-hook";
import { syncActiveSkills } from "../../src/skills/bridge";
import { searchSkills, writeSkill } from "../../src/skills/library";
import { getSkill, setStatus, upsertSkill } from "../../src/state/repos/skills";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { rmWithRetry } from "../helpers/rm-with-retry";

const trajectory = {
  prompt: "Run the capture approval fixture checks",
  reply: "Replacement capture contains the stalecapturemarker instructions.",
  tools: [{ name: "Bash", ok: true }],
};
const proposal = proposeSkillFromTrajectory(trajectory)!;
const reviewed = {
  name: proposal.name,
  description: "Run the reviewedpublicationmarker fixture checks.",
  skillMd: "# Reviewed instructions\n\nKeep the reviewedpublicationmarker procedure.\n",
};

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "hermes-capture-approval-"));
  try {
    await run(cwd);
  } finally {
    await resetSharedDbCache();
    await rmWithRetry(cwd);
  }
}

async function seedReviewedCandidate(cwd: string): Promise<void> {
  await writeSkill(reviewed, cwd);
  upsertSkill(await getSharedDb(cwd), {
    name: proposal.name,
    path: `.claude/hermes/skills/${proposal.name}`,
    status: "candidate",
  });
}

function published(cwd: string, db: Awaited<ReturnType<typeof getSharedDb>>) {
  const dir = join(cwd, ".claude", "hermes", "skills", proposal.name);
  return {
    skillMd: readFileSync(join(dir, "SKILL.md"), "utf8"),
    description: readFileSync(join(dir, "description.txt"), "utf8"),
    indexed: db
      .query<{ name: string; description: string }, [string]>(
        "SELECT name, description FROM skill_descriptions_fts WHERE name = ?"
      )
      .all(proposal.name),
  };
}

function expectedPublication(skillMd: string, description: string) {
  return { skillMd, description, indexed: [{ name: proposal.name, description }] };
}

for (const status of ["active", "shadow", "disabled"] as const) {
  test(`capture preserves the complete publication reviewed when status becomes ${status}`, async () => {
    await withWorkspace(async (cwd) => {
      await seedReviewedCandidate(cwd);
      const db = await getSharedDb(cwd);
      const pendingCapture = captureCandidateSkill({ ...trajectory, cwd }, { captureCandidateSkills: true });

      // The cached DB promise resumes capture first. The real asynchronous
      // write path then yields; approval runs synchronously before it resumes.
      // A synchronous publisher may instead finish before approval, which is
      // valid provided body, description, and FTS all describe that generation.
      await Promise.resolve();
      const approved = published(cwd, db);
      expect([
        expectedPublication(reviewed.skillMd, reviewed.description),
        expectedPublication(proposal.body, proposal.description),
      ]).toContainEqual(approved);
      expect(getSkill(db, proposal.name)?.status).toBe("candidate");
      setStatus(db, proposal.name, status);

      const result = await pendingCapture;
      expect(getSkill(db, proposal.name)?.status).toBe(status);
      expect(published(cwd, db)).toEqual(approved);
      expect(["captured", "skipped:exists"]).toContain(result.status);
      expect(searchSkills(db, "reviewedpublicationmarker").map((hit) => hit.name)).toEqual(
        approved.description === reviewed.description ? [proposal.name] : []
      );
    });
  });
}

test("new capture and candidate recapture refresh body, description, and FTS together", async () => {
  await withWorkspace(async (cwd) => {
    const db = await getSharedDb(cwd);
    const first = await captureCandidateSkill({ ...trajectory, cwd }, { captureCandidateSkills: true });
    expect(first.status).toBe("captured");
    expect(getSkill(db, proposal.name)?.status).toBe("candidate");
    expect(published(cwd, db)).toEqual(expectedPublication(proposal.body, proposal.description));

    await seedReviewedCandidate(cwd);
    expect(searchSkills(db, "reviewedpublicationmarker").map((hit) => hit.name)).toEqual([proposal.name]);
    const recapture = await captureCandidateSkill({ ...trajectory, cwd }, { captureCandidateSkills: true });
    expect(recapture.status).toBe("captured");
    expect(getSkill(db, proposal.name)?.status).toBe("candidate");
    expect(published(cwd, db)).toEqual(expectedPublication(proposal.body, proposal.description));
    expect(searchSkills(db, "reviewedpublicationmarker")).toEqual([]);
  });
});

function mirrored(cwd: string) {
  const dir = join(cwd, ".claude", "skills", `hermes_${proposal.name}`);
  if (!existsSync(dir)) return null;
  return {
    skillMd: readFileSync(join(dir, "SKILL.md"), "utf8"),
    description: readFileSync(join(dir, "description.txt"), "utf8"),
  };
}

for (const change of ["body", "description", "body and description"] as const) {
  test(`managed ${change} changes require approval of the changed publication before mirroring`, async () => {
    await withWorkspace(async (cwd) => {
      await seedReviewedCandidate(cwd);
      const db = await getSharedDb(cwd);
      setStatus(db, proposal.name, "active");
      expect((await syncActiveSkills(db, cwd)).mirrored).toEqual([proposal.name]);
      expect(mirrored(cwd)).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });

      const changed = {
        name: proposal.name,
        skillMd: change === "description" ? reviewed.skillMd : proposal.body,
        description: change === "body" ? reviewed.description : proposal.description,
      };
      await writeSkill(changed, cwd);
      expect(getSkill(db, proposal.name)?.status).toBe("active");
      expect(published(cwd, db)).toEqual(expectedPublication(changed.skillMd, changed.description));
      await syncActiveSkills(db, cwd);
      const beforeReapproval = mirrored(cwd);
      if (beforeReapproval !== null) {
        // Keeping the old approved mirror or removing it is safe. Publishing
        // either changed file under the previous approval is not.
        expect(beforeReapproval).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });
      }

      // Repeating explicit approval must authorize precisely the latest
      // complete publication even though the registry status is already active.
      setStatus(db, proposal.name, "active");
      expect((await syncActiveSkills(db, cwd)).mirrored).toEqual([proposal.name]);
      expect(mirrored(cwd)).toEqual({ skillMd: changed.skillMd, description: changed.description });
    });
  });
}

test("legacy active files stay usable until a managed rewrite requires fresh approval", async () => {
  await withWorkspace(async (cwd) => {
    const dir = join(cwd, ".claude", "hermes", "skills", proposal.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), reviewed.skillMd);
    writeFileSync(join(dir, "description.txt"), reviewed.description);
    const db = await getSharedDb(cwd);
    upsertSkill(db, { name: proposal.name, path: dir, status: "active" });
    expect((await syncActiveSkills(db, cwd)).mirrored).toEqual([proposal.name]);
    expect(mirrored(cwd)).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });

    await writeSkill({ name: proposal.name, skillMd: proposal.body, description: proposal.description }, cwd);
    await syncActiveSkills(db, cwd);
    const beforeReapproval = mirrored(cwd);
    if (beforeReapproval !== null) {
      expect(beforeReapproval).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });
    }
    setStatus(db, proposal.name, "active");
    expect((await syncActiveSkills(db, cwd)).mirrored).toEqual([proposal.name]);
    expect(mirrored(cwd)).toEqual({ skillMd: proposal.body, description: proposal.description });
  });
});

for (const state of ["legacy", "managed"] as const) {
  test(`failed ${state} publication metadata cannot expose changed files under the old approval`, async () => {
    await withWorkspace(async (cwd) => {
      const db = await getSharedDb(cwd);
      if (state === "legacy") {
        const dir = join(cwd, ".claude", "hermes", "skills", proposal.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), reviewed.skillMd);
        writeFileSync(join(dir, "description.txt"), reviewed.description);
        upsertSkill(db, { name: proposal.name, path: dir, status: "active" });
      } else {
        await seedReviewedCandidate(cwd);
        setStatus(db, proposal.name, "active");
      }
      expect((await syncActiveSkills(db, cwd)).mirrored).toEqual([proposal.name]);
      expect(mirrored(cwd)).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });

      // Inject a deterministic SQLite write failure at the metadata boundary.
      // File writes cannot roll back with the transaction, so a failed first
      // publication must not revive the unmanaged compatibility exception.
      const operation = state === "legacy" ? "INSERT" : "UPDATE";
      db.exec(`CREATE TRIGGER reject_publication BEFORE ${operation} ON skill_publications
        BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
      try {
        await expect(
          writeSkill({ name: proposal.name, skillMd: proposal.body, description: proposal.description }, cwd)
        ).rejects.toThrow("injected publication failure");
      } finally {
        db.exec("DROP TRIGGER reject_publication");
      }

      expect(getSkill(db, proposal.name)?.status).toBe("active");
      await syncActiveSkills(db, cwd);
      const afterFailure = mirrored(cwd);
      if (afterFailure !== null) {
        expect(afterFailure).toEqual({ skillMd: reviewed.skillMd, description: reviewed.description });
      }
    });
  });
}
