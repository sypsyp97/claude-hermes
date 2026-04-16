/**
 * Regression tests for five concrete bugs discovered in the Hermes codebase.
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
 *   Bug 4  handleCallbackQuery does not check allowedUserIds before hitting
 *          the 127.0.0.1:9999 secretary endpoint.
 *   Bug 5  "Allowed users: all" banner is a lie after the fail-closed
 *          commit — an empty allowlist means NOBODY, not everybody.
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
// Bug 4: handleCallbackQuery must check allowedUserIds before fetching
// ---------------------------------------------------------------------------

describe("Bug 4 — telegram handleCallbackQuery must enforce the allowlist", () => {
  test("contract: handleCallbackQuery body references both query.from.id and allowedUserIds", () => {
    // handleCallbackQuery is not exported. The authz fix must land inside
    // its body (src/commands/telegram.ts:924). A compliant implementation
    // references both `query.from.id` (the caller identity) and
    // `allowedUserIds` (the fail-closed list). With the current fail-closed
    // contract, an empty allowlist rejects everyone.
    const src = readFileSync(join(REPO_ROOT, "src", "commands", "telegram.ts"), "utf8");

    // Extract the function body. Match from the declaration until the next
    // top-level `async function` / `function` or the `// --- ` section
    // divider that follows it in the file.
    const declRe = /async function handleCallbackQuery\s*\([^)]*\)\s*:\s*Promise<void>\s*\{/;
    const declMatch = declRe.exec(src);
    expect(declMatch).not.toBeNull();
    if (!declMatch) return;

    const bodyStart = declMatch.index + declMatch[0].length;
    // Balance braces to find the matching close.
    let depth = 1;
    let i = bodyStart;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    const body = src.slice(bodyStart, i - 1);

    // The fix must reference the caller's id AND the allowlist. Accept
    // either `query.from.id` or a destructured equivalent like
    // `const fromId = query.from?.id` — any token that contains both
    // "from" and ".id" within one handful of chars. Keep this loose so
    // we test the behaviour, not the exact phrasing.
    const referencesFromId = /query\.from\??\.id/.test(body) || /from\.id/.test(body);
    const referencesAllowlist = /allowedUserIds/.test(body);

    expect(referencesFromId).toBe(true);
    expect(referencesAllowlist).toBe(true);
  });

  test("behaviour: an unauthorised callback query must NOT hit the secretary fetch endpoint", async () => {
    // The real handleCallbackQuery is unexported, so we drive the contract
    // from the outside: stand up a fake secretary on 127.0.0.1:9999, then
    // post a Telegram callback-query update to the polling loop entry that
    // is reachable — or, if no ingress is exposed, re-run the contract
    // assertion that is guaranteed to exercise the fix path. Because there
    // IS no public ingress yet, we fall back to a structural check: the
    // module body must guard the fetch with an allowlist comparison before
    // the `fetch("http://127.0.0.1:9999/confirm/...")` line.
    const src = readFileSync(join(REPO_ROOT, "src", "commands", "telegram.ts"), "utf8");

    // Look at the region that spans from the handleCallbackQuery declaration
    // until the fetch URL literal. The allowlist check must appear BEFORE
    // the fetch on the 127.0.0.1:9999 endpoint.
    const declIdx = src.indexOf("async function handleCallbackQuery");
    expect(declIdx).toBeGreaterThan(-1);

    const fetchIdx = src.indexOf("127.0.0.1:9999/confirm/", declIdx);
    expect(fetchIdx).toBeGreaterThan(-1);

    const prefix = src.slice(declIdx, fetchIdx);
    // The guard must reject non-allowlisted users before we ever open a
    // socket to the local secretary. That means we must see a comparison
    // against allowedUserIds in this prefix.
    expect(prefix).toMatch(/allowedUserIds/);
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
