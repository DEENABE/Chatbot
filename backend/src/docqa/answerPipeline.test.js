// node --test src/docqa/answerPipeline.test.js   (from backend/)
// answerWithPlanner(): rules first, model only when the rules are unsure, and every
// model-written plan is repaired against the real data before it runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../config.js';
import { answerWithPlanner } from './queryPlanner.js';

const cities = ['Chennai', 'Madurai', 'Salem', 'Pune'];
const companies = ['TCS', 'Infosys', 'Zoho'];
const rows = Array.from({ length: 80 }, (_, i) => [
  `EMP${100 + i}`,
  `Person ${i}`,
  cities[i % 4],
  companies[i % 3],
  String(40000 + (i % 10) * 10000),
  `20${15 + (i % 10)}-0${1 + (i % 9)}-1${i % 9}`,
]);
const table = {
  id: 't1',
  filename: 'staff.xlsx',
  sheet: 'Staff',
  columns: ['Emp ID', 'Name', 'City', 'Company', 'Salary', 'Joining Date'],
  rowCount: rows.length,
  documentId: 'd1',
};
const loadRows = () => rows;

let server;
let calls = [];
let reply = () => ({ table: null });

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const user = parsed.messages?.at(-1)?.content || '';
      calls.push(user);
      if (reply === 'fail') {
        res.writeHead(500).end('boom');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { content: JSON.stringify(reply(user)) } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.ollamaUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const plan = (question, extra = {}) =>
  answerWithPlanner({ question, tables: [table], loadRows, model: 'fake', ...extra });

test('a question the rules fully explain never calls the model', async () => {
  calls = [];
  const out = await plan('how many employees in Chennai');
  assert.equal(out.source, 'rules');
  assert.equal(calls.length, 0);
  assert.equal(out.matched, rows.filter((r) => r[2] === 'Chennai').length);
  assert.match(out.answer, /COUNT = 20/);
});

test('a plain name lookup is left to the row search', async () => {
  calls = [];
  const out = await plan('Person 7 details');
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('unsure question → model plan is repaired (misspelt value, wrong column name)', async () => {
  calls = [];
  reply = () => ({
    table: 'T1',
    filters: [{ column: 'Location', op: 'contains', value: 'Chenai' }],
    operation: 'count',
  });
  // "headcount" is a word the rules do not know → they hand over to the model
  const out = await plan('what is the headcount in Chenai');
  assert.equal(out.source, 'llm');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Chennai/); // schema lists the real values
  assert.deepEqual(out.plan.filters, [{ column: 'City', op: 'equals', value: 'Chennai' }]);
  assert.equal(out.matched, rows.filter((r) => r[2] === 'Chennai').length);
  assert.ok(out.changes.length > 0);
});

test('model forgets a filter the question names → it is added back', async () => {
  reply = () => ({
    table: 'T1',
    filters: [{ column: 'Company', op: 'equals', value: 'TCS' }],
    operation: 'count',
  });
  const out = await plan('what is the strength of TCS in Pune');
  assert.equal(out.source, 'llm');
  assert.equal(out.matched, rows.filter((r) => r[3] === 'TCS' && r[2] === 'Pune').length);
});

test('model invents a value → dropped, never silently returns zero rows', async () => {
  reply = () => ({
    table: 'T1',
    filters: [
      { column: 'City', op: 'equals', value: 'Chennai' },
      { column: 'Company', op: 'equals', value: 'Atlantis Corp' },
    ],
    operation: 'count',
  });
  const out = await plan('what is the strength of Chennai');
  assert.equal(out.matched, rows.filter((r) => r[2] === 'Chennai').length);
});

test('model unreachable → rules plan is used when it already has filters', async () => {
  reply = 'fail';
  const out = await plan('what is the strength of Madurai staff');
  assert.equal(out.source, 'rules-fallback');
  assert.equal(out.matched, rows.filter((r) => r[2] === 'Madurai').length);
  reply = () => ({ table: null });
});

test('model says no table + rules have nothing → null (falls back to normal retrieval)', async () => {
  reply = () => ({ table: null });
  const out = await plan('how many leaves can I take');
  assert.equal(out, null);
});

test('non-analytical question never reaches the model', async () => {
  calls = [];
  const out = await plan('explain the onboarding policy');
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('computed answers use Indian number grouping and per-group aggregates', async () => {
  const out = await plan('total salary');
  const expected = rows.reduce((a, r) => a + Number(r[4]), 0);
  assert.equal(out.value, expected);
  assert.match(out.answer, new RegExp(expected.toLocaleString('en-IN')));
  const grouped = await plan('average salary per company');
  assert.match(grouped.answer, /\| Company \| Rows \| AVG of "Salary" \|/);
  assert.equal(grouped.groups.length, 3);
});

test('no match explains which filter found nothing', async () => {
  const out = await plan('how many employees in Chennai joined after 2090');
  assert.equal(out.matched, 0);
  assert.match(out.answer, /No row matches all the filters/);
  assert.match(out.answer, /City = Chennai → 20 rows on its own/);
});

test('top-N answers say what they show', async () => {
  const out = await plan('top 3 highest salary');
  assert.match(out.answer, /\*\*Top 3 by Salary \(highest first\)\*\*/);
  assert.equal(out.indexes.length, rows.length); // all rows considered, 3 shown
  const shownRows = out.answer.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(shownRows.length, 3);
});
