import { expect, test } from "bun:test";
import type { Job } from "../jobs";
import { createScheduledJobDispatcher } from "./start";

function job(name = "slow", recurring = false): Job {
  return { name, schedule: "* * * * *", prompt: "test", recurring, notify: false };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("overlapping matching ticks admit only one execution of a slow job", async () => {
  const dispatch = createScheduledJobDispatcher();
  const gate = deferred();
  let starts = 0;
  let clears = 0;
  const deps = {
    resolvePrompt: async (prompt: string) => prompt,
    run: async () => {
      starts++;
      await gate.promise;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    clearJobSchedule: async () => {
      clears++;
    },
  };
  const first = dispatch(job(), deps);
  const duplicate = dispatch(job(), deps);
  await flush();
  gate.resolve();
  await Promise.all([first, duplicate]);
  expect(starts).toBe(1);
  expect(clears).toBe(1);
});

test("admission remains locked until one-shot schedule cleanup finishes", async () => {
  const dispatch = createScheduledJobDispatcher();
  const gate = deferred();
  let starts = 0;
  const deps = {
    resolvePrompt: async (prompt: string) => prompt,
    run: async () => {
      starts++;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    clearJobSchedule: async () => {
      await gate.promise;
    },
  };
  const first = dispatch(job(), deps);
  await flush();
  const duplicate = dispatch(job(), deps);
  await flush();
  gate.resolve();
  await Promise.all([first, duplicate]);
  expect(starts).toBe(1);
});

test("failed jobs can retry, and unrelated job names run independently", async () => {
  const dispatch = createScheduledJobDispatcher();
  const gate = deferred();
  const starts: string[] = [];
  const deps = {
    resolvePrompt: async (prompt: string) => prompt,
    run: async (name: string) => {
      starts.push(name);
      if (name === "slow") await gate.promise;
      return { stdout: "", stderr: "", exitCode: 1 };
    },
    clearJobSchedule: async () => {},
  };
  const pending = dispatch(job(), deps);
  await dispatch(job("other"), deps);
  expect(starts).toEqual(["slow", "other"]);
  gate.resolve();
  await pending;
  await dispatch(job(), deps);
  expect(starts).toEqual(["slow", "other", "slow"]);
});
