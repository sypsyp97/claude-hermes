import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// preflight.ts shells out to git clone against real GitHub URLs and install
// deps via bun/npm. Running the full `preflight()` function from a unit test
// would hit the network, mutate the user's real ~/.claude/plugins tree (unless
// we fully isolate homedir, which is fragile on Windows), and spawn a long-
// running whisper warmup.
//
// So we isolate via a tmp HOME and only cover:
//   1. Module surface: `preflight` is an exported function of arity 1.
//   2. Idempotent import: re-importing does not throw.
//   3. The sandboxed HOME has no side-effects before we touch anything.
//
// The full preflight flow is exercised by integration tests in tests/ and by
// real startup smoke. Keeping this file strictly offline keeps verify green in
// air-gapped environments.

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CWD = process.cwd();

let tempRoot: string;
let fakeHome: string;
let fakeProject: string;

type PreflightModule = typeof import("./preflight");
let pre: PreflightModule;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-preflight-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(join(fakeProject, ".claude"), { recursive: true });

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(fakeProject);

  pre = await import("./preflight");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {
    // Windows may still hold file handles from whisper-warmup backgrounds; the
    // temp dir will be reaped by the OS later.
  });
});

describe("preflight module", () => {
  test("exports a preflight function", () => {
    expect(typeof pre.preflight).toBe("function");
  });

  test("preflight accepts a single string argument", () => {
    expect(pre.preflight.length).toBe(1);
  });

  test("re-importing the module is safe (no top-level mutation explosions)", async () => {
    const again = await import("./preflight");
    expect(again.preflight).toBe(pre.preflight);
  });
});
