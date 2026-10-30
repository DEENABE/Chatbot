import { OPERATIONS, FILTER_OPERATORS, AGGREGATES, TableOpError, resolveColumn } from './tableOps.js';

/**
 * The local model turns a request into a small JSON plan of table operations.
 * The plan is validated against the real columns; if the model is unavailable
 * or its plan is unusable, a keyword fallback handles the common requests.
 */

const SYSTEM = `You convert a user's spreadsheet request into a JSON plan. You never compute results yourself.
Return ONLY a JSON object: {"merge": boolean, "operations": [...], "outputName": "short-file-name"}
"merge": true only if the user wants several tables/files combined into one.
Allowed operations (use exact column names from the schema):
{"op":"trim"}  -- remove extra spaces
{"op":"dropEmptyRows"}
{"op":"dropEmptyColumns"}
{"op":"dedupe","columns":["optional key columns"]}  -- remove duplicate rows
{"op":"filter","column":"Col","operator":"= | != | > | >= | < | <= | contains | notContains | startsWith | endsWith | empty | notEmpty","value":"text or number"}
{"op":"sort","column":"Col","direction":"asc|desc"}
{"op":"select","columns":["Col1","Col2"]}  -- keep only these columns
{"op":"remove","columns":["Col"]}
{"op":"rename","from":"Old","to":"New"}
{"op":"fillEmpty","column":"optional Col","value":"text"}
{"op":"groupBy","by":["Col"],"aggregates":[{"fn":"sum|count|avg|min|max","column":"Col"}]}
{"op":"limit","n":10}
"Clean" means trim + dropEmptyRows + dedupe. Keep operations in the order they must run. Use as few as needed.`;

const STRING_FIELDS = ['column', 'from', 'to', 'direction', 'operator'];

export function validatePlan(plan, tables) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TableOpError('The plan is not an object.');
  const operations = Array.isArray(plan.operations) ? plan.operations.slice(0, 20) : [];
  const merge = plan.merge === true && tables.length > 1;
  // Columns available after an optional merge (union of names).
  let columns = merge
    ? [...new Set(tables.flatMap((t) => t.columns))].concat('Source')
    : tables.reduce((all, t) => all.concat(t.columns), []);
  const clean = [];
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object' || !OPERATIONS.includes(raw.op))
      throw new TableOpError(`Unsupported operation ${JSON.stringify(raw?.op)}.`);
    const op = { op: raw.op };
    for (const f of STRING_FIELDS) if (typeof raw[f] === 'string') op[f] = raw[f].slice(0, 200);
    if (raw.value !== undefined && raw.value !== null) op.value = typeof raw.value === 'number' ? raw.value : String(raw.value).slice(0, 500);
    if (Array.isArray(raw.columns)) op.columns = raw.columns.filter((c) => typeof c === 'string').slice(0, 50);
    if (raw.by !== undefined) op.by = (Array.isArray(raw.by) ? raw.by : [raw.by]).filter((c) => typeof c === 'string').slice(0, 10);
    if (Array.isArray(raw.aggregates))
      op.aggregates = raw.aggregates
        .filter((a) => a && AGGREGATES.includes(a.fn))
        .slice(0, 10)
        .map((a) => ({ fn: a.fn, ...(typeof a.column === 'string' ? { column: a.column } : {}) }));
    if (raw.n !== undefined) op.n = Number(raw.n);
    if (op.op === 'filter' && !FILTER_OPERATORS.includes(op.operator)) throw new TableOpError(`Unknown filter operator ${op.operator}.`);
    // Check columns exist (throws with the list of real columns).
    for (const c of [op.column, op.from, ...(op.columns || []), ...(op.by || []), ...(op.aggregates || []).map((a) => a.column)])
      if (c) resolveColumn(columns, c);
    if (op.op === 'rename') columns = columns.map((c) => (c === op.from ? op.to : c));
    if (op.op === 'groupBy') {
      if (!op.by?.length) throw new TableOpError('groupBy needs at least one column.');
      const aggs = op.aggregates?.length ? op.aggregates : [{ fn: 'count' }];
      columns = [
        ...op.by,
        ...aggs.map((a) => (a.column ? `${a.fn[0].toUpperCase()}${a.fn.slice(1)} of ${a.column}` : 'Count')),
      ];
    }
    if (op.op === 'select') columns = op.columns;
    clean.push(op);
  }
  const outputName = typeof plan.outputName === 'string' ? plan.outputName.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().slice(0, 80) : '';
  return { merge, operations: clean, outputName };
}

/** Keyword fallback for the most common requests. */
export function fallbackPlan(request, tables) {
  const r = String(request || '').toLowerCase();
  const operations = [];
  const merge = tables.length > 1 && /\b(?:merge|combine|append|join|one (?:file|sheet))\b|இணை/.test(r);
  if (/\bclean|சுத்தம்/.test(r)) operations.push({ op: 'trim' }, { op: 'dropEmptyRows' }, { op: 'dedupe' });
  else {
    if (/\btrim|extra spaces/.test(r)) operations.push({ op: 'trim' });
    if (/(?:remove|delete|drop) (?:empty|blank) rows/.test(r)) operations.push({ op: 'dropEmptyRows' });
    if (/(?:remove|delete|drop) (?:empty|blank) columns/.test(r)) operations.push({ op: 'dropEmptyColumns' });
    if (/duplicate|dedupe|நகல்/.test(r)) operations.push({ op: 'dedupe' });
  }
  if (!operations.length && !merge) return null;
  return { merge, operations, outputName: '' };
}

function schemaText(tables) {
  return tables
    .map((t, i) => {
      const sample = t.rows.slice(0, 3).map((r) => JSON.stringify(r.map((v) => (typeof v === 'string' ? v.slice(0, 40) : v))));
      return `Table ${i + 1}: "${t.name}" (${t.rows.length} rows)\nColumns: ${JSON.stringify(t.columns)}\nSample rows:\n${sample.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * @returns {Promise<{plan, source: 'model'|'fallback', error?: string}>}
 */
export async function planTableOperations({ request, tables, completeJSON, model, signal }) {
  let error;
  if (completeJSON) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await completeJSON({
          system: SYSTEM,
          prompt: `${schemaText(tables)}\n\nUser request: ${request}${error ? `\n\nYour previous plan was rejected: ${error}. Fix it.` : ''}`,
          model,
          signal,
          think: false,
          temperature: 0,
          numPredict: 600,
        });
        const plan = validatePlan(raw, tables);
        if (plan.operations.length || plan.merge) return { plan, source: 'model' };
        error = 'The plan had no operations.';
      } catch (e) {
        if (signal?.aborted) throw e;
        error = e instanceof TableOpError ? e.message : 'The local model did not return a usable plan.';
      }
    }
  }
  const fallback = fallbackPlan(request, tables);
  if (fallback) return { plan: fallback, source: 'fallback', error };
  throw new TableOpError(
    `I could not turn that request into table operations${error ? ` (${error})` : ''}. Try for example: "remove duplicates", "filter Status = Paid and export to Excel", "sort by Date descending", "total Amount by Region", or "merge these files".`,
  );
}

export function describeOperation(op) {
  switch (op.op) {
    case 'trim':
      return 'Trimmed extra spaces';
    case 'dropEmptyRows':
      return 'Removed empty rows';
    case 'dropEmptyColumns':
      return 'Removed empty columns';
    case 'dedupe':
      return op.columns?.length ? `Removed duplicates by ${op.columns.join(', ')}` : 'Removed duplicate rows';
    case 'filter':
      return `Kept rows where ${op.column} ${op.operator}${['empty', 'notEmpty'].includes(op.operator) ? '' : ` ${op.value}`}`;
    case 'sort':
      return `Sorted by ${op.column} (${String(op.direction || 'asc').startsWith('d') ? 'descending' : 'ascending'})`;
    case 'select':
      return `Kept columns ${op.columns.join(', ')}`;
    case 'remove':
      return `Removed columns ${op.columns.join(', ')}`;
    case 'rename':
      return `Renamed ${op.from} → ${op.to}`;
    case 'fillEmpty':
      return `Filled empty ${op.column || 'cells'} with "${op.value}"`;
    case 'groupBy':
      return `Grouped by ${op.by.join(', ')} (${(op.aggregates || []).map((a) => `${a.fn}${a.column ? ` of ${a.column}` : ''}`).join(', ') || 'count'})`;
    case 'limit':
      return `Kept the first ${op.n} rows`;
    default:
      return op.op;
  }
}
