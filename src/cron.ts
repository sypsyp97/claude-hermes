import { shiftDateToOffset } from "./timezone";

export class CronParseError extends Error {
  constructor(expr: string, detail: string) {
    super(`invalid cron expression "${expr}": ${detail}`);
    this.name = "CronParseError";
  }
}

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface FieldSpec {
  name: keyof CronFields;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 },
];

/**
 * Strictly parse a 5-field cron expression. Throws CronParseError on any
 * malformed input. Callers that need a graceful fallback should wrap this.
 */
export function parseCron(expr: string): CronFields {
  const raw = expr.trim();
  if (!raw) throw new CronParseError(expr, "empty expression");
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(expr, `expected 5 fields, got ${parts.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const fields: CronFields = { minute, hour, dayOfMonth, month, dayOfWeek };
  for (const spec of FIELDS) {
    validateField(expr, spec, fields[spec.name]);
  }
  return fields;
}

function validateField(expr: string, spec: FieldSpec, field: string): void {
  if (!field) throw new CronParseError(expr, `empty ${spec.name} field`);
  for (const part of field.split(",")) {
    if (!part) throw new CronParseError(expr, `empty list element in ${spec.name}`);
    const [rangeRaw, stepRaw] = part.split("/");
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        throw new CronParseError(expr, `bad step "${stepRaw}" in ${spec.name}`);
      }
    }
    if (rangeRaw === "*") continue;
    if (rangeRaw.includes("-")) {
      const [loRaw, hiRaw] = rangeRaw.split("-");
      if (!/^\d+$/.test(loRaw) || !/^\d+$/.test(hiRaw)) {
        throw new CronParseError(expr, `bad range "${rangeRaw}" in ${spec.name}`);
      }
      const lo = Number(loRaw);
      const hi = Number(hiRaw);
      if (lo < spec.min || hi > spec.max || lo > hi) {
        throw new CronParseError(
          expr,
          `range ${lo}-${hi} out of [${spec.min}, ${spec.max}] for ${spec.name}`,
        );
      }
      continue;
    }
    if (!/^\d+$/.test(rangeRaw)) {
      throw new CronParseError(expr, `bad value "${rangeRaw}" in ${spec.name}`);
    }
    const n = Number(rangeRaw);
    if (n < spec.min || n > spec.max) {
      throw new CronParseError(
        expr,
        `value ${n} out of [${spec.min}, ${spec.max}] for ${spec.name}`,
      );
    }
  }
}

function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

/**
 * Non-throwing match check. Invalid expressions simply return false so callers
 * (statusline updater, scheduler tick) can't be taken down by a malformed
 * frontmatter value. Validate separately via parseCron() if you want to know.
 */
export function cronMatches(
  expr: string | CronFields,
  date: Date,
  timezoneOffsetMinutes = 0,
): boolean {
  let fields: CronFields;
  try {
    fields = typeof expr === "string" ? parseCron(expr) : expr;
  } catch {
    return false;
  }
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };
  return (
    matchCronField(fields.minute, d.minute) &&
    matchCronField(fields.hour, d.hour) &&
    matchCronField(fields.dayOfMonth, d.dayOfMonth) &&
    matchCronField(fields.month, d.month) &&
    matchCronField(fields.dayOfWeek, d.dayOfWeek)
  );
}

/**
 * Find the next minute after `after` that matches `expr`. Returns null if no
 * match is found within a year — calendars like "Feb 30" are unsatisfiable.
 * Throws CronParseError if the expression itself is invalid.
 */
export function nextCronMatch(
  expr: string | CronFields,
  after: Date,
  timezoneOffsetMinutes = 0,
): Date | null {
  const fields = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const MINUTES_IN_YEAR = 366 * 24 * 60;
  for (let i = 0; i < MINUTES_IN_YEAR; i++) {
    if (cronMatches(fields, d, timezoneOffsetMinutes)) return new Date(d);
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/**
 * Every minute in (from, to] that matches `expr`. Used by the scheduler to
 * catch up on minutes missed across a clock jump, daemon sleep, or blocked
 * event loop. Capped at 24 hours of lookback to contain runaway clocks.
 */
export function matchesBetween(
  expr: string | CronFields,
  from: Date,
  to: Date,
  timezoneOffsetMinutes = 0,
): Date[] {
  if (from.getTime() >= to.getTime()) return [];
  let fields: CronFields;
  try {
    fields = typeof expr === "string" ? parseCron(expr) : expr;
  } catch {
    return [];
  }
  const MAX_LOOKBACK_MIN = 24 * 60;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const hits: Date[] = [];
  for (let i = 0; i <= MAX_LOOKBACK_MIN; i++) {
    if (d.getTime() > to.getTime()) break;
    if (cronMatches(fields, d, timezoneOffsetMinutes)) hits.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return hits;
}
