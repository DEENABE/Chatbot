import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { askLimiter } from '../middleware/rateLimiter.js';
import { isValidUuid } from '../lib/validateUuid.js';
import { DocIntelError, errorBody } from '../docintel/errors.js';
import { FORMATS, LIMITS } from '../docintel/formats.js';
import { describeDocument } from '../docintel/parser.js';
import {
  AGGREGATES,
  FILTER_OPS,
  aggregate,
  extractPages,
  filterRows,
  findDuplicates,
  groupRows,
  idRange,
  paginate,
  searchRows,
  searchText,
  sortRows,
} from '../docintel/operations.js';
import { executeTask, routeTask, sourceOf } from '../docintel/agent.js';
import { supportedTargets } from '../docintel/conversion.js';
import { findSoffice } from '../docintel/libreoffice.js';
import { findPdftoppm, localOcrLanguages } from '../docintel/ocr.js';
import { renderDocument } from '../docintel/generation.js';
import { validateSpec } from '../docintel/explainer.js';
import { display, normKey } from '../docintel/values.js';
import { config } from '../config.js';

/**
 * REST API of the Document Intelligence Agent (localhost only, bearer-session
 * auth, owner-scoped). Exact operations answer synchronously with paginated
 * rows and source references; conversions, generation and natural-language
 * tasks run as cancellable jobs with progress. Downloads use the existing
 * authenticated /api/file-agent/outputs/:id route.
 */

class BadRequest extends DocIntelError {
  constructor(message) {
    super('BAD_REQUEST', message, { status: 400 });
  }
}

const str = (v, field, { max = 500, optional = false } = {}) => {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new BadRequest(`${field} is required.`);
  }
  if (typeof v !== 'string' && typeof v !== 'number')
    throw new BadRequest(`${field} must be text.`);
  const s = String(v).trim();
  if (s.length > max) throw new BadRequest(`${field} is too long.`);
  return s;
};
const int = (v, field, { min = 1, max = 1e9, fallback } = {}) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequest(`${field} must be a whole number between ${min} and ${max}.`);
  return n;
};
const uuid = (v, field) => {
  const s = str(v, field, { max: 36 });
  if (!isValidUuid(s)) throw new BadRequest(`${field} is not a valid id.`);
  return s;
};

export function validateConditions(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 20)
    throw new BadRequest('conditions must be a list of at most 20 items.');
  return list.map((c, i) => {
    if (!c || typeof c !== 'object') throw new BadRequest(`conditions[${i}] is invalid.`);
    const op = str(c.op, `conditions[${i}].op`, { max: 20 });
    if (!FILTER_OPS.includes(op))
      throw new BadRequest(`conditions[${i}].op must be one of ${FILTER_OPS.join(', ')}.`);
    const out = { column: str(c.column, `conditions[${i}].column`, { max: 200 }), op };
    if (op === 'in') {
      if (!Array.isArray(c.value) || !c.value.length || c.value.length > 200)
        throw new BadRequest(`conditions[${i}].value must be a list.`);
      out.value = c.value.map((v, k) => str(v, `conditions[${i}].value[${k}]`, { max: 200 }));
    } else if (!['empty', 'not_empty'].includes(op))
      out.value = str(c.value, `conditions[${i}].value`, { max: 200 });
    if (['between', 'date_between'].includes(op))
      out.value2 = str(c.value2, `conditions[${i}].value2`, { max: 200 });
    if (c.inclusive !== undefined) out.inclusive = c.inclusive === true;
    return out;
  });
}

function validateSort(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 5)
    throw new BadRequest('sort must be a list of at most 5 items.');
  return list.map((s, i) => ({
    column: str(s?.column, `sort[${i}].column`, { max: 200 }),
    direction: s?.direction === 'desc' ? 'desc' : 'asc',
  }));
}

const rowView = (table, rows) => rows.map((r) => ({ ref: r.ref, values: r.values.map(display) }));

export function createDocIntelRouter({
  auth = requireAuth,
  deps,
  makeDeps,
  limiter = askLimiter,
  jobs,
  results,
} = {}) {
  const router = Router();
  router.use(auth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof DocIntelError)
        return res.status(error.status || 400).json(errorBody(error));
      next(error);
    }
  };

  const getDeps = async (req) => (makeDeps ? makeDeps(req) : deps);

  async function loadOne(req, id) {
    const d = await getDeps(req);
    const [doc] = await d.loadDocuments(req.userId, [id]);
    if (!doc) throw new DocIntelError('NOT_FOUND', 'Document not found.', { status: 404 });
    if (doc.failed) throw doc.failed;
    return doc;
  }

  function pickTable(doc, sheet) {
    if (!doc.tables?.length) throw new DocIntelError('NO_TABLES', `"${doc.name}" has no tables.`);
    if (!sheet) return doc.tables[0];
    const t =
      doc.tables.find((x) => x.name === sheet) ||
      doc.tables.find((x) => normKey(x.name) === normKey(sheet));
    if (!t)
      throw new DocIntelError(
        'SHEET_NOT_FOUND',
        `Sheet "${sheet}" was not found. Sheets: ${doc.tables.map((x) => x.name).join(', ')}.`,
        { status: 404, details: { sheets: doc.tables.map((x) => x.name) } },
      );
    return t;
  }

  const paged = (req, table, doc, rows, extra = {}) => {
    const p = paginate(rows, {
      page: int(req.body?.page, 'page', { fallback: 1 }),
      pageSize: int(req.body?.pageSize, 'pageSize', {
        max: LIMITS.maxPageSize,
        fallback: LIMITS.pageSize,
      }),
    });
    return {
      ...extra,
      table: table.name,
      columns: table.columns,
      total: p.total,
      page: p.page,
      pages: p.pages,
      pageSize: p.pageSize,
      rows: rowView(table, p.rows),
      source: sourceOf(
        doc,
        table,
        rows.map((r) => r.ref),
      ),
    };
  };

  router.get(
    '/capabilities',
    handle(async (_req, res) => {
      const soffice = !!findSoffice();
      res.json({
        formats: Object.keys(FORMATS),
        conversions: Object.fromEntries(
          Object.keys(FORMATS).map((ext) => [ext, supportedTargets(ext)]),
        ),
        aggregates: AGGREGATES,
        filterOps: FILTER_OPS,
        engines: {
          libreoffice: soffice,
          pdftoppm: !!findPdftoppm(),
          ocrLanguages: localOcrLanguages(config.ocrDir),
        },
        limits: {
          maxFileMB: Math.round(LIMITS.maxFileBytes / 1048576),
          maxRows: LIMITS.maxRows,
          pageSize: LIMITS.pageSize,
          maxPageSize: LIMITS.maxPageSize,
        },
      });
    }),
  );

  router.get(
    '/documents/:id',
    handle(async (req, res) =>
      res.json(describeDocument(await loadOne(req, uuid(req.params.id, 'id')))),
    ),
  );

  router.post(
    '/documents/:id/search',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const query = str(req.body?.query, 'query', { max: 200 });
      if (doc.tables?.length && ['spreadsheet', 'json'].includes(doc.kind)) {
        const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
        const r = searchRows(table, table.rows, query, {
          column: str(req.body?.column, 'column', { optional: true, max: 200 }),
          exact: req.body?.exact === true,
        });
        return res.json(
          paged(req, table, doc, r.rows, {
            operation: 'search',
            query,
            matches: r.matches.slice(0, 5000),
          }),
        );
      }
      res.json({ operation: 'search', ...searchText(doc, query) });
    }),
  );

  router.post(
    '/documents/:id/range',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
      const r = idRange(table, {
        from: str(req.body?.from, 'from', { max: 40 }),
        to: str(req.body?.to, 'to', { max: 40 }),
        column: str(req.body?.column, 'column', { optional: true, max: 200 }),
      });
      res.json(
        paged(req, table, doc, r.rows, {
          operation: 'range',
          column: r.column,
          requested: r.requested,
          missing: r.missing.slice(0, 1000),
          missingCount: r.missingCount,
          duplicates: r.duplicates,
          verified: r.verified,
        }),
      );
    }),
  );

  router.post(
    '/documents/:id/filter',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
      const f = filterRows(table, table.rows, validateConditions(req.body?.conditions));
      const sort = validateSort(req.body?.sort);
      const rows = sort.length ? sortRows(table, f.rows, sort) : f.rows;
      res.json(
        paged(req, table, doc, rows, {
          operation: 'filter',
          conditions: f.conditions.map(({ column, op, value, value2 }) => ({
            column,
            op,
            value,
            value2,
          })),
          skipped: f.skipped.slice(0, 500),
          skippedCount: f.skipped.length,
        }),
      );
    }),
  );

  router.post(
    '/documents/:id/aggregate',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
      const fn = str(req.body?.fn, 'fn', { max: 20 }).toUpperCase();
      if (!AGGREGATES.includes(fn))
        throw new BadRequest(`fn must be one of ${AGGREGATES.join(', ')}.`);
      const r = aggregate(table, table.rows, {
        fn,
        column: str(req.body?.column, 'column', { optional: true, max: 200 }),
        criteria: validateConditions(req.body?.criteria),
      });
      res.json({
        operation: 'aggregate',
        table: table.name,
        ...r,
        source: sourceOf(doc, table, []),
      });
    }),
  );

  router.post(
    '/documents/:id/group',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
      const by = (Array.isArray(req.body?.by) ? req.body.by : [req.body?.by])
        .slice(0, 3)
        .map((b, i) => str(b, `by[${i}]`, { max: 200 }));
      const aggs = (Array.isArray(req.body?.aggregates) ? req.body.aggregates : [{ fn: 'COUNTA' }])
        .slice(0, 5)
        .map((a, i) => {
          const fn = str(a?.fn, `aggregates[${i}].fn`, { max: 20 }).toUpperCase();
          if (!AGGREGATES.includes(fn) || /IF$/.test(fn))
            throw new BadRequest(`aggregates[${i}].fn is not supported for grouping.`);
          return {
            fn,
            column: str(a?.column, `aggregates[${i}].column`, { optional: true, max: 200 }),
          };
        });
      const g = groupRows(table, table.rows, { by, aggregates: aggs });
      res.json({
        operation: 'group',
        table: table.name,
        ...g,
        rows: g.rows.map((r) => ({ values: r.values, rows: r.members.length })),
        source: sourceOf(doc, table, []),
      });
    }),
  );

  router.post(
    '/documents/:id/duplicates',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const table = pickTable(doc, str(req.body?.sheet, 'sheet', { optional: true, max: 100 }));
      const cols = Array.isArray(req.body?.columns)
        ? req.body.columns.slice(0, 20).map((c, i) => str(c, `columns[${i}]`, { max: 200 }))
        : undefined;
      const d = findDuplicates(table, table.rows, { columns: cols });
      res.json({
        operation: 'duplicates',
        table: table.name,
        columns: d.columns,
        groups: d.groups.slice(0, 2000),
        groupCount: d.groups.length,
        duplicateRows: d.duplicateRows,
        source: sourceOf(doc, table, []),
      });
    }),
  );

  router.post(
    '/documents/:id/pages',
    handle(async (req, res) => {
      const doc = await loadOne(req, uuid(req.params.id, 'id'));
      const from = int(req.body?.from, 'from', { max: 100000 });
      const r = extractPages(doc, from, int(req.body?.to, 'to', { max: 100000, fallback: from }));
      res.json({
        operation: 'pages',
        ...r,
        pages: r.pages.map((p) => ({
          number: p.number,
          text: p.text,
          scanned: p.scanned,
          ocr: p.ocr || null,
        })),
      });
    }),
  );

  // ---- jobs: natural-language tasks, conversion, generation ----
  const startJob = (req, res, kind, run) => {
    const job = jobs.start(req.userId, kind, run);
    res.status(202).json(jobs.view(job));
  };

  router.post(
    '/tasks',
    limiter,
    handle(async (req, res) => {
      const message = str(req.body?.message, 'message', { max: 4000 });
      const ids = Array.isArray(req.body?.documentIds)
        ? req.body.documentIds.slice(0, 20).map((id, i) => uuid(id, `documentIds[${i}]`))
        : [];
      const d = await getDeps(req);
      startJob(req, res, 'task', async ({ signal, progress }) => {
        progress(5, 'Reading the documents');
        const docs = ids.length
          ? await d.loadDocuments(req.userId, ids, { signal, status: (m) => progress(20, m) })
          : [];
        if (ids.length && !docs.length)
          throw new DocIntelError('NOT_FOUND', 'None of the documents were found.', {
            status: 404,
          });
        const task = routeTask(message, docs);
        if (!task)
          return {
            status: 'unrecognized',
            markdown:
              'This request is not a document operation I can run exactly. Ask it in chat, or rephrase (e.g. "list P110 to P115", "sum of Total Cost", "convert to PDF").',
          };
        progress(35, 'Working');
        const result = await executeTask(task, docs, {
          userId: req.userId,
          message,
          signal,
          status: (m) => progress(60, m),
          emit: () => {},
          chat: d.chat,
          completeJSON: d.completeJSON,
          outputs: d.outputs,
          results: d.results,
        });
        return { task, ...result };
      });
    }),
  );

  router.post(
    '/convert',
    limiter,
    handle(async (req, res) => {
      const id = uuid(req.body?.documentId, 'documentId');
      const target = str(req.body?.target, 'target', { max: 10 }).toLowerCase();
      const d = await getDeps(req);
      startJob(req, res, 'convert', async ({ signal, progress }) => {
        const docs = await d.loadDocuments(req.userId, [id], { signal });
        if (!docs.length)
          throw new DocIntelError('NOT_FOUND', 'Document not found.', { status: 404 });
        progress(30, `Converting to ${target.toUpperCase()}`);
        return executeTask({ action: 'convert', documents: [id], output: target }, docs, {
          userId: req.userId,
          signal,
          outputs: d.outputs,
          results: d.results,
          status: (m) => progress(60, m),
        });
      });
    }),
  );

  router.post(
    '/generate',
    limiter,
    handle(async (req, res) => {
      const format = str(req.body?.format, 'format', { max: 10 }).toLowerCase();
      if (!['docx', 'pdf', 'xlsx', 'csv', 'html', 'txt', 'md', 'json'].includes(format))
        throw new BadRequest('format is not supported.');
      const spreadsheet = format === 'xlsx' || format === 'csv';
      const spec =
        validateSpec(req.body?.spec, false) ||
        (spreadsheet ? validateTables(req.body?.spec) : null);
      if (!spec)
        throw new BadRequest('spec must contain a title and blocks (or sheets for spreadsheets).');
      const d = await getDeps(req);
      startJob(req, res, 'generate', async ({ progress }) => {
        progress(30, 'Creating the file');
        const { verifyOutput, verificationSummary } = await import('../docintel/verify.js');
        const { OUTPUT_MIME, withExtension } = await import('../docintel/formats.js');
        const r = await renderDocument(format, {
          title: spec.title,
          blocks: spec.blocks || [],
          sheets: spec.sheets,
          header: spec.title,
        });
        const v = await verifyOutput(
          r.buffer,
          format,
          spec.sheets
            ? { sheets: spec.sheets.map((s) => ({ rows: s.rows.length })) }
            : { contains: [spec.title.slice(0, 40)] },
        );
        if (!v.ok)
          throw new DocIntelError('VERIFY_FAILED', verificationSummary(v), { status: 422 });
        const saved = await d.outputs.save(
          req.userId,
          withExtension(spec.title, format),
          r.buffer,
          OUTPUT_MIME[format],
          { docintel: true, verification: v },
        );
        return { status: 'ok', output: saved, verification: v, notes: r.notes };
      });
    }),
  );

  router.get(
    '/jobs/:id',
    handle(async (req, res) => {
      const job = jobs.get(req.userId, uuid(req.params.id, 'id'));
      if (!job) throw new DocIntelError('NOT_FOUND', 'Job not found.', { status: 404 });
      res.json(jobs.view(job));
    }),
  );

  router.post(
    '/jobs/:id/cancel',
    handle(async (req, res) => {
      const job = jobs.cancel(req.userId, uuid(req.params.id, 'id'));
      if (!job) throw new DocIntelError('NOT_FOUND', 'Job not found.', { status: 404 });
      res.json(jobs.view(job));
    }),
  );

  router.get(
    '/results/:id',
    handle(async (req, res) => {
      const stored = results.get(req.userId, uuid(req.params.id, 'id'));
      if (!stored)
        throw new DocIntelError('EXPIRED', 'This result has expired. Ask the question again.', {
          status: 404,
        });
      const p = paginate(stored.rows, {
        page: int(req.query.page, 'page', { fallback: 1 }),
        pageSize: int(req.query.pageSize, 'pageSize', { max: LIMITS.maxPageSize, fallback: 100 }),
      });
      res.json({
        title: stored.title,
        columns: stored.columns,
        source: stored.source,
        total: p.total,
        page: p.page,
        pages: p.pages,
        pageSize: p.pageSize,
        from: p.from,
        to: p.to,
        rows: p.rows,
      });
    }),
  );

  return router;
}

function validateTables(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.sheets)) return null;
  const sheets = spec.sheets
    .slice(0, 20)
    .map((s, i) => {
      const columns = (Array.isArray(s?.columns) ? s.columns : [])
        .slice(0, LIMITS.maxColumns)
        .map((c) => String(c ?? '').slice(0, 200));
      const rows = (Array.isArray(s?.rows) ? s.rows : [])
        .slice(0, LIMITS.maxRows)
        .map((r) =>
          Array.isArray(r)
            ? r
                .slice(0, columns.length)
                .map((v) =>
                  typeof v === 'number' || typeof v === 'boolean' || v === null
                    ? v
                    : String(v).slice(0, 32767),
                )
            : [],
        );
      return {
        name: String(s?.name || `Sheet${i + 1}`).slice(0, 31),
        columns,
        rows,
        totals: Array.isArray(s?.totals) ? s.totals.filter((t) => columns.includes(t)) : [],
      };
    })
    .filter((s) => s.columns.length);
  if (!sheets.length) return null;
  return { title: String(spec.title || 'Workbook').slice(0, 150), sheets };
}
