import { display, isBlank, normKey, splitId } from './values.js';

/**
 * Deterministic document comparison. Text: line-level Myers diff with
 * "changed" pairs (a removed line followed by a similar added line). Tables:
 * matched by a shared key column (IDs), reporting added / removed rows and
 * changed cells. The model only explains this result; it never decides it.
 */

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function textUnits(doc) {
  if (doc.pages)
    return doc.pages.flatMap((p) =>
      p.text
        .split(/\n+/)
        .map(clean)
        .filter(Boolean)
        .map((text) => ({ text, where: `page ${p.number}` })),
    );
  if (doc.blocks)
    return doc.blocks.flatMap((b) => {
      const where = `paragraph ${b.index}`;
      if (b.type === 'list') return b.items.map((t) => ({ text: clean(t), where }));
      if (b.type === 'table')
        return b.rows.map((r) => ({ text: clean(r.join(' | ')), where: `table ${b.table}` }));
      return [{ text: clean(b.text), where }];
    });
  return String(doc.text || '')
    .split(/\n+/)
    .map(clean)
    .filter(Boolean)
    .map((text, i) => ({ text, where: `line ${i + 1}` }));
}

/** Myers O((N+M)·D) diff over arrays of strings → [{ op: '='|'-'|'+', a?, b? }]. */
export function diffSequences(a, b, { maxD = 4000 } = {}) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null; // too different for an edit script; caller falls back to set comparison
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ op: '=', a: --x, b: --y });
    if (x === prevX) ops.push({ op: '+', b: --y });
    else ops.push({ op: '-', a: --x });
  }
  while (x > 0 && y > 0) ops.push({ op: '=', a: --x, b: --y });
  return ops.reverse();
}

function similarity(s, t) {
  const A = new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const B = new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

export function compareText(docA, docB, { maxItems = 200 } = {}) {
  const A = textUnits(docA);
  const B = textUnits(docB);
  const ka = A.map((u) => u.text.toLowerCase());
  const kb = B.map((u) => u.text.toLowerCase());
  const ops = A.length + B.length <= 40_000 ? diffSequences(ka, kb) : null;
  const added = [];
  const removed = [];
  const changed = [];
  let same = 0;
  if (!ops) {
    const setB = new Set(kb);
    const setA = new Set(ka);
    A.forEach((u, i) => !setB.has(ka[i]) && removed.push(u));
    B.forEach((u, i) => !setA.has(kb[i]) && added.push(u));
    same = ka.filter((k) => setB.has(k)).length;
  } else {
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.op === '=') {
        same++;
        continue;
      }
      if (
        o.op === '-' &&
        ops[i + 1]?.op === '+' &&
        similarity(A[o.a].text, B[ops[i + 1].b].text) >= 0.5
      ) {
        changed.push({ before: A[o.a], after: B[ops[i + 1].b] });
        i++;
      } else if (o.op === '-') removed.push(A[o.a]);
      else added.push(B[o.b]);
    }
  }
  return {
    unitsA: A.length,
    unitsB: B.length,
    same,
    identical: !added.length && !removed.length && !changed.length,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    added: added.slice(0, maxItems),
    removed: removed.slice(0, maxItems),
    changed: changed.slice(0, maxItems),
    truncated: added.length > maxItems || removed.length > maxItems || changed.length > maxItems,
  };
}

function keyColumn(ta, tb) {
  const shared = ta.columns.filter((c) => tb.columns.some((d) => normKey(d) === normKey(c)));
  const score = (c) => {
    const i = ta.columns.indexOf(c);
    const vals = ta.rows.map((r) => display(r.values[i]).trim()).filter(Boolean);
    const unique = new Set(vals).size === vals.length && vals.length > 0;
    // IDs have a prefix (P110, EMP-7); plain numbers are amounts, not keys.
    const idLike = vals.filter((v) => splitId(v)?.prefix).length / Math.max(1, vals.length);
    const numeric = vals.length && vals.every((v) => /^[-+]?[\d,]+(?:\.\d+)?$/.test(v));
    return (
      (unique ? 2 : 0) +
      idLike +
      (/\b(id|code|no|number|sku|key)\b/i.test(c) ? 1 : 0) -
      (numeric ? 1.5 : 0)
    );
  };
  const best = shared.map((c) => ({ c, s: score(c) })).sort((x, y) => y.s - x.s)[0];
  return best && best.s >= 2 ? best.c : null;
}

export function compareTables(ta, tb, { maxItems = 200 } = {}) {
  const key = keyColumn(ta, tb);
  const colsB = new Map(tb.columns.map((c, i) => [normKey(c), i]));
  const shared = ta.columns
    .map((c, i) => ({ c, ia: i, ib: colsB.get(normKey(c)) }))
    .filter((x) => x.ib !== undefined);
  const result = {
    tableA: ta.name,
    tableB: tb.name,
    key,
    columnsAdded: tb.columns.filter((c) => !ta.columns.some((d) => normKey(d) === normKey(c))),
    columnsRemoved: ta.columns.filter((c) => !colsB.has(normKey(c))),
    rowsA: ta.rows.length,
    rowsB: tb.rows.length,
  };
  if (!key) {
    const sig = (t, r) =>
      JSON.stringify(
        shared.map((s) =>
          display(r.values[t === 'a' ? s.ia : s.ib])
            .trim()
            .toLowerCase(),
        ),
      );
    const setB = new Map(tb.rows.map((r) => [sig('b', r), r]));
    const setA = new Map(ta.rows.map((r) => [sig('a', r), r]));
    const removed = ta.rows.filter((r) => !setB.has(sig('a', r)));
    const added = tb.rows.filter((r) => !setA.has(sig('b', r)));
    return {
      ...result,
      mode: 'rows',
      addedRows: added.slice(0, maxItems).map((r) => r.ref),
      removedRows: removed.slice(0, maxItems).map((r) => r.ref),
      counts: { added: added.length, removed: removed.length, changed: 0 },
      changes: [],
    };
  }
  const ka = ta.columns.indexOf(key);
  const kb = colsB.get(normKey(key));
  const mapB = new Map();
  for (const r of tb.rows) {
    const k = display(r.values[kb]).trim().toLowerCase();
    if (k) mapB.set(k, r);
  }
  const seen = new Set();
  const changes = [];
  const removed = [];
  for (const r of ta.rows) {
    const k = display(r.values[ka]).trim().toLowerCase();
    if (!k) continue;
    seen.add(k);
    const other = mapB.get(k);
    if (!other) {
      removed.push(display(r.values[ka]));
      continue;
    }
    for (const s of shared) {
      const va = r.values[s.ia];
      const vb = other.values[s.ib];
      if (isBlank(va) && isBlank(vb)) continue;
      if (display(va).trim() !== display(vb).trim())
        changes.push({
          key: display(r.values[ka]),
          column: s.c,
          before: display(va),
          after: display(vb),
          rowA: r.ref,
          rowB: other.ref,
        });
    }
  }
  const added = [...mapB.entries()]
    .filter(([k]) => !seen.has(k))
    .map(([, r]) => display(r.values[kb]));
  return {
    ...result,
    mode: 'key',
    counts: { added: added.length, removed: removed.length, changed: changes.length },
    added: added.slice(0, maxItems),
    removed: removed.slice(0, maxItems),
    changes: changes.slice(0, maxItems),
    truncated: changes.length > maxItems || added.length > maxItems || removed.length > maxItems,
  };
}

export function compareDocuments(a, b) {
  const tables = [];
  if (a.tables.length && b.tables.length) {
    for (const ta of a.tables.slice(0, 10)) {
      const tb =
        b.tables.find((t) => normKey(t.name) === normKey(ta.name)) ||
        (a.tables.length === 1 && b.tables.length === 1 ? b.tables[0] : null);
      if (tb) tables.push(compareTables(ta, tb));
    }
  }
  const text = a.kind === 'spreadsheet' && b.kind === 'spreadsheet' ? null : compareText(a, b);
  return { a: a.name, b: b.name, text, tables };
}
