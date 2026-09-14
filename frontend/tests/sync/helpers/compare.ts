/**
 * The typed comparator. Every distinction it makes corresponds to a real
 * round-trip bug, so none of them are pedantry:
 *
 *   1 vs "1"          — an integer that came back as text
 *   true vs 1         — a boolean that lost its type crossing sqlite
 *   null vs undefined vs ABSENT — an omitted key that the server turned into
 *                       NULL (silent erasure), which "both are falsy" hides
 *   [] vs null        — an empty array stored as NULL
 *   180.5 vs 180      — a REAL coerced to INTEGER
 */
export interface Diff {
  path: string;
  expected: unknown;
  expectedType: string;
  actual: unknown;
  actualType: string;
}

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

export function diffValues(expected: unknown, actual: unknown, path = ''): Diff[] {
  const et = typeOf(expected);
  const at = typeOf(actual);
  const mismatch = (): Diff[] => [
    { path: path || '(root)', expected, expectedType: et, actual, actualType: at },
  ];

  if (et !== at) return mismatch();
  if (et === 'array') {
    const e = expected as unknown[];
    const a = actual as unknown[];
    if (e.length !== a.length) return mismatch();
    return e.flatMap((v, i) => diffValues(v, a[i], path + '[' + i + ']'));
  }
  if (et === 'object') {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    const out: Diff[] = [];
    for (const key of keys) {
      const child = path ? path + '.' + key : key;
      // An ABSENT key is not the same as a present null — that distinction is
      // the whole omitted-optional-field erasure bug.
      if (!(key in e) || !(key in a)) {
        out.push({
          path: child,
          expected: key in e ? e[key] : undefined,
          expectedType: key in e ? typeOf(e[key]) : 'absent',
          actual: key in a ? a[key] : undefined,
          actualType: key in a ? typeOf(a[key]) : 'absent',
        });
        continue;
      }
      out.push(...diffValues(e[key], a[key], child));
    }
    return out;
  }
  // Object.is keeps float comparison exact and separates 0 from -0.
  return Object.is(expected, actual) ? [] : mismatch();
}

export type Rows = Record<string, unknown>[];

/** Compare two stores by row id, optionally ignoring bookkeeping columns. */
export function diffStore(expected: Rows, actual: Rows, ignore: string[] = []): Diff[] {
  const strip = (r: Record<string, unknown>) => {
    const copy = { ...r };
    for (const key of ignore) delete copy[key];
    return copy;
  };
  const byId = (rows: Rows) => new Map(rows.map((r) => [String(r.id), strip(r)]));
  const e = byId(expected);
  const a = byId(actual);
  const ids = new Set([...e.keys(), ...a.keys()]);
  const out: Diff[] = [];
  for (const id of ids) {
    const left = e.get(id);
    const right = a.get(id);
    if (!left || !right) {
      out.push({
        path: 'id=' + id,
        expected: left,
        expectedType: left ? 'row' : 'missing',
        actual: right,
        actualType: right ? 'row' : 'missing',
      });
      continue;
    }
    out.push(...diffValues(left, right, 'id=' + id));
  }
  return out;
}

export function diffDb(
  expected: Record<string, Rows>,
  actual: Record<string, Rows>,
  ignore: string[] = []
): Diff[] {
  const stores = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...stores].flatMap((store) =>
    diffStore(expected[store] ?? [], actual[store] ?? [], ignore).map((d) => ({
      ...d,
      path: store + '.' + d.path,
    }))
  );
}

export function formatDiffs(diffs: Diff[]): string {
  return diffs
    .map(
      (d) =>
        '  ' + d.path + ': expected ' + JSON.stringify(d.expected) + ' (' + d.expectedType +
        ') but got ' + JSON.stringify(d.actual) + ' (' + d.actualType + ')'
    )
    .join('\n');
}
