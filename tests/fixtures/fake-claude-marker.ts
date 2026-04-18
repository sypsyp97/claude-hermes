#!/usr/bin/env bun
/**
 * Minimal fake-claude variant for "was this invoked?" tests.
 *
 * Writes `HERMES_FAKE_MARKER_PATH` (absolute path) on first invocation and
 * exits successfully with a trivial JSON envelope. Tests that want to
 * assert the runner was NEVER reached point `HERMES_CLAUDE_BIN` at this
 * fixture and then check `existsSync(markerPath) === false`.
 */

import { appendFileSync, writeFileSync } from "node:fs";

const markerPath = process.env.HERMES_FAKE_MARKER_PATH;
if (markerPath) {
  try {
    // `appendFileSync` so repeated invocations each leave a line (useful
    // for tests that want to count calls, not just detect one).
    appendFileSync(markerPath, `called ${new Date().toISOString()}\n`);
  } catch {
    // Fallback to writeFileSync — if append fails, at least make the marker
    // exist so the negative assertion `exists === false` still flips.
    try {
      writeFileSync(markerPath, `called ${new Date().toISOString()}\n`);
    } catch {
      // nothing else to do
    }
  }
}

// Emit a minimal envelope so the runner's JSON parse does not crash on
// the happy path (lets us write positive-control tests too).
const sessionId = process.env.HERMES_FAKE_SESSION_ID ?? "marker-sess";
const envelopes = [
  { type: "system", subtype: "init", session_id: sessionId, model: "fake" },
  { type: "result", subtype: "success", session_id: sessionId, result: "ok", num_turns: 1 },
];
process.stdout.write(JSON.stringify(envelopes) + "\n");
process.exit(0);
