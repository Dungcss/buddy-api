// Token-usage mapping for the WorkBuddy/OpenAI-compatible upstream.
//
// Rules enforced here, because the dashboard must never invent numbers:
//   * input_tokens  = upstream prompt_tokens. The upstream schema counts cached
//     prompt tokens inside prompt_tokens (verified: prompt_cache_hit_tokens +
//     prompt_cache_miss_tokens === prompt_tokens), so cache read is NOT added
//     to input again.
//   * output_tokens = upstream completion_tokens.
//   * cache_write_tokens is only taken from an explicit upstream field
//     (prompt_cache_write_tokens or cache_creation_input_tokens). It is never
//     derived from input.
//   * cache_read_tokens is only taken from an explicit upstream field
//     (prompt_cache_hit_tokens, prompt_tokens_details.cached_tokens, or
//     cache_read_input_tokens).
//   * A missing field is null ("no data"), which is distinct from a real 0.

const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const getPath = (object, path) => {
  let cursor = object;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
};

// First explicit upstream field that carries a valid count. Returns both the
// value and the field name so the dashboard can show provenance.
function pick(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (isCount(value)) return { value, field: path.join('.') };
  }
  return { value: null, field: null };
}

export const USAGE_FIELDS = Object.freeze([
  'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens',
]);

export function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = pick(raw, [['prompt_tokens'], ['input_tokens']]);
  const output = pick(raw, [['completion_tokens'], ['output_tokens']]);
  const cacheRead = pick(raw, [
    ['prompt_cache_hit_tokens'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['cache_read_input_tokens'],
  ]);
  const cacheWrite = pick(raw, [
    ['prompt_cache_write_tokens'],
    ['cache_creation_input_tokens'],
  ]);
  const total = pick(raw, [['total_tokens']]);
  const miss = pick(raw, [['prompt_cache_miss_tokens']]);
  const thinking = pick(raw, [['completion_thinking_tokens'], ['completion_tokens_details', 'reasoning_tokens']]);
  const credit = pick(raw, [['credit']]);

  const usage = {
    input_tokens: input.value,
    output_tokens: output.value,
    cache_write_tokens: cacheWrite.value,
    cache_read_tokens: cacheRead.value,
    total_tokens: total.value,
    prompt_cache_miss_tokens: miss.value,
    thinking_tokens: thinking.value,
    credit: credit.value,
    cache_read_field: cacheRead.field,
    cache_write_field: cacheWrite.field,
    total_field: total.field,
    // True only when upstream's own hit+miss fields prove that prompt_tokens
    // already contains the cached part. null means "not provable".
    input_includes_cache_read: null,
  };

  if (input.value !== null && cacheRead.value !== null) {
    if (miss.value !== null) {
      const sum = cacheRead.value + miss.value;
      if (sum === input.value) usage.input_includes_cache_read = true;
      else if (sum > input.value) usage.input_includes_cache_read = false;
    } else if (cacheRead.value > input.value) {
      usage.input_includes_cache_read = false;
    }
  }

  const any = USAGE_FIELDS.some(key => usage[key] !== null) ||
    usage.thinking_tokens !== null || usage.credit !== null;
  return any ? usage : null;
}

// Sum the usage actually received across upstream attempts. A retried request
// contributes each attempt once; a single attempt's usage is never multiplied
// by the retry count.
export function combineUsage(entries) {
  const normalized = (entries || [])
    .map(entry => normalizeUsage(entry && entry.raw !== undefined ? entry.raw : entry))
    .filter(Boolean);
  if (!normalized.length) return null;
  if (normalized.length === 1) return { ...normalized[0], usage_attempts: 1 };

  const combined = { usage_attempts: normalized.length, combined: true };
  for (const key of [...USAGE_FIELDS, 'thinking_tokens', 'credit']) {
    let sum = null;
    for (const usage of normalized) {
      const value = usage[key];
      if (typeof value === 'number') sum = (sum ?? 0) + value;
    }
    combined[key] = sum;
  }
  combined.input_includes_cache_read = normalized.every(usage => usage.input_includes_cache_read === true)
    ? true : normalized.some(usage => usage.input_includes_cache_read === false) ? false : null;
  combined.cache_read_field = normalized.map(usage => usage.cache_read_field).find(Boolean) || null;
  combined.cache_write_field = normalized.map(usage => usage.cache_write_field).find(Boolean) || null;
  combined.total_field = normalized.every(usage => usage.total_field) ? 'total_tokens' : null;
  return combined;
}

// Detail rows are flattened, so aggregateRows accepts either the nested form
// (`row.usage`) used in tests, or the flat token fields used by the dashboard
// API. A row with no usage at all stays "missing" and contributes nothing.
function usageOfRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.usage !== undefined) return row.usage && typeof row.usage === 'object' ? row.usage : null;
  // The dashboard API marks rows that never received an upstream usage object.
  if (row.usage_present === false) return null;
  const flat = {};
  for (const key of [...USAGE_FIELDS, 'thinking_tokens', 'credit']) if (row[key] !== undefined) flat[key] = row[key];
  // Provenance travels with the row: the aggregate needs to know whether the
  // upstream schema proved that prompt_tokens already contained the cached part.
  if (row.input_includes_cache_read !== undefined) flat.input_includes_cache_read = row.input_includes_cache_read;
  // Every null means upstream sent no usage at all, which stays "missing".
  const any = Object.values(flat).some(value => value !== null);
  return any ? flat : null;
}

export function emptyTotals() {
  return {
    requests: 0,
    usage_requests: 0,
    missing_usage: 0,
    input_tokens: null,
    output_tokens: null,
    cache_write_tokens: null,
    cache_read_tokens: null,
    total_tokens: null,
    coverage: Object.fromEntries(USAGE_FIELDS.map(key => [key, 0])),
    // Whether prompt_tokens contains the cached part is a property of the
    // upstream schema, not something to assume. Each row carries its own answer
    // (true / false / null = not provable); the aggregate keeps all three counts
    // so the page can say "proven", "mixed" or "upstream did not say".
    input_includes_cache_read: null,
    cache_read_in_input: { true: 0, false: 0, unknown: 0 },
  };
}

// Aggregate the same detail rows the table shows, so the summary always matches
// the request list. Rows without usage stay "missing": they never contribute 0.
export function aggregateRows(rows) {
  const totals = emptyTotals();
  for (const row of rows || []) {
    totals.requests += 1;
    const usage = usageOfRow(row);
    if (!usage) { totals.missing_usage += 1; continue; }
    totals.usage_requests += 1;
    const includes = usage.input_includes_cache_read;
    const bucket = includes === true ? 'true' : includes === false ? 'false' : 'unknown';
    totals.cache_read_in_input[bucket] += 1;
    for (const key of USAGE_FIELDS) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] = (totals[key] ?? 0) + value;
        totals.coverage[key] += 1;
      }
    }
  }
  const counts = totals.cache_read_in_input;
  if (counts.true && !counts.false && !counts.unknown) totals.input_includes_cache_read = 'yes';
  else if (counts.false && !counts.true && !counts.unknown) totals.input_includes_cache_read = 'no';
  else if (counts.true || counts.false || counts.unknown) totals.input_includes_cache_read = 'mixed';
  return totals;
}

export function groupTotals(rows, keyOf) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...aggregateRows(list) }))
    .sort((a, b) => b.requests - a.requests || String(a.key).localeCompare(String(b.key)));
}
