/**
 * Regression tests for concrete bugs discovered in the Hermes codebase.
 * Each test describes correct behavior that the code does NOT yet exhibit, so
 * these are expected to FAIL on the current tree. A separate fixer pass is
 * expected to drive them green without touching the assertions.
 *
 *   Bug 1  stop.ts freezes paths from process.cwd() at import (tested in
 *          src/commands/stop.test.ts, driver-script style).
 *   Bug 2  telegram.ts:886 omits source="telegram" from runUserMessage, so
 *          thread sessions created from Telegram land under source='cli'.
 *   Bug 3  start.ts double-opens state.db by calling bootstrapState() after
 *          bootstrap(); shared-db.ts owns the single handle.
 *   Bug 5  "Allowed users: all" banner is a lie after the fail-closed
 *          commit — an empty allowlist means NOBODY, not everybody.
 *
 * Bug 4 (handleCallbackQuery secretary auth gate) was retired alongside the
 * removal of the 127.0.0.1:9999 secretary integration; no callback-button
 * patterns remain to gate.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Bug 2: telegram.ts:886 must pass source="telegram" to runUserMessage
// ---------------------------------------------------------------------------

describe("Bug 2 — telegram runner call carries source='telegram'", () => {
  test('contract: every runUserMessage call in telegram.ts ends with the literal source arg "telegram"', () => {
    // Behavior-level: when telegram eventually forwards a threadId (forum
    // topic) the underlying runUserMessage call MUST carry source="telegram"
    // so the session row gets keyed under thread:telegram:<id>, not the
    // default thread:cli:<id>. The Discord bridge does this correctly at
    // discord.ts:689 (last positional arg is the string "discord"). Parse
    // every runUserMessage(...) call and confirm its LAST top-level arg is
    // the literal "telegram".
    const src = readFileSync(join(REPO_ROOT, "src", "commands", "telegram.ts"), "utf8");

    // Locate each call, then walk forward balancing parentheses so we pick
    // up the full arg list even if it spans multiple lines.
    const calls: string[] = [];
    const callMarker = /runUserMessage\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callMarker.exec(src)) !== null) {
      let depth = 1;
      let j = m.index + m[0].length;
      const start = j;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      calls.push(src.slice(start, j - 1));
    }

    expect(calls.length).toBeGreaterThan(0);

    // Top-level comma split that respects nested parens, template strings,
    // and simple quoted strings.
    function splitArgs(argList: string): string[] {
      const parts: string[] = [];
      let depth = 0;
      let buf = "";
      let quote: string | null = null;
      for (let k = 0; k < argList.length; k++) {
        const ch = argList[k];
        const prev = k > 0 ? argList[k - 1] : "";
        if (quote) {
          buf += ch;
          if (ch === quote && prev !== "\\") quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          buf += ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === "," && depth === 0) {
          parts.push(buf.trim());
          buf = "";
          continue;
        }
        buf += ch;
      }
      if (buf.trim()) parts.push(buf.trim());
      return parts;
    }

    for (const argList of calls) {
      const args = splitArgs(argList);
      // Must pass a source argument (positional, 5th): telegram must be
      // explicit, not inherited from the ThreadSource="cli" default.
      expect(args.length).toBeGreaterThanOrEqual(5);
      const last = args[args.length - 1];
      expect(last).toBe(`"telegram"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 3: start.ts double-opens state.db (bootstrapState after bootstrap())
// ---------------------------------------------------------------------------

describe("Bug 3 — start.ts must not call bootstrapState() (shared-db is sole owner)", () => {
  test("start.ts source has zero calls to bootstrapState(", () => {
    // shared-db.ts is the only place allowed to open state.db during normal
    // daemon boot (see banner comment at src/state/shared-db.ts:5-12).
    // A second handle from bootstrapState() violates that contract and has
    // caused leaked WAL sidecars on Windows. The fix is to drop the call
    // entirely — getSharedDb() already runs migrations and the importer.
    const src = readFileSync(join(REPO_ROOT, "src", "commands", "start.ts"), "utf8");
    const hits = src.match(/bootstrapState\s*\(/g) ?? [];
    expect(hits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 4 retired alongside the secretary integration — see header comment.
// Guard: secretary endpoint must not creep back in.
// ---------------------------------------------------------------------------

describe("secretary integration removed", () => {
  test("no source file references 127.0.0.1:9999 anymore", () => {
    const files = [
      join(REPO_ROOT, "src", "commands", "telegram.ts"),
      join(REPO_ROOT, "src", "commands", "discord.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("127.0.0.1:9999");
      expect(src).not.toMatch(/sec_(yes|no)_\[/);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 5: "Allowed users: all" banner lies after fail-closed
// ---------------------------------------------------------------------------

describe("Bug 5 — empty allowlist banner must not say 'all'", () => {
  test("no bridge banner renders 'all' for an empty allowedUserIds list", () => {
    // After the fail-closed commit (3138613), an empty allowlist means
    // NOBODY can use the bridge. The three banner lines in discord.ts and
    // telegram.ts currently print "all" in that case, which is misleading.
    // The fix should replace that branch with something like "none
    // (fail-closed)" or "0 (fail-closed)".
    const files = [
      join(REPO_ROOT, "src", "commands", "discord.ts"),
      join(REPO_ROOT, "src", "commands", "telegram.ts"),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Look for the exact ternary pattern that fabricates the "all" label
      // from an empty allowlist.
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/allowedUserIds\.length\s*===\s*0\s*\?\s*"all"/.test(line)) {
          offenders.push(`${f}:${i + 1} -> ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
