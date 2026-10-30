// node --test src/docqa/columnProjection.test.js   (from backend/)
// "show data for only id", "list product names", "name and city mattum": the answer is a table with just
// those columns, computed by the rules (no model call), and questions that only look similar stay as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuestion } from './questionCompiler.js';
import { executePlan } from './queryPlanner.js';

const cats = ['Electronics', 'Furniture', 'Stationery', 'Hardware'];
const suppliers = ['Acme Corp', 'Globex', 'Initech', 'Umbrella'];
const columns = [
  'Product ID',
  'Product Name',
  'Category',
  'Quantity in Stock',
  'Unit Price',
  'Reorder Level',
  'Supplier',
  'Supplier ID',
  'Last Restocked',
];
const rows = Array.from({ length: 46 }, (_, i) => [
  `P${1001 + i}`,
  `Item ${i + 1} ${['Mouse', 'Chair', 'Pen', 'Drill'][i % 4]}`,
  cats[i % 4],
  String(10 + ((i * 7) % 90)),
  String(100 + i * 13),
  String(20 + (i % 5) * 5),
  suppliers[i % 4],
  `S${10 + (i % 4)}`,
  `2024-0${1 + (i % 9)}-1${i % 9}`,
]);
const table = {
  id: 't1',
  filename: 'Inventory-Records-Sample-Data.xlsx',
  sheet: 'Inventory Records Data',
  columns,
  rowCount: rows.length,
};
const compile = (question) => compileQuestion(question, [{ table, rows }]);
const tableHeader = (answer) => answer.split('\n').find((line) => line.startsWith('| #'));

function project(question) {
  const compiled = compile(question);
  assert.equal(compiled.kind, 'analytic', question);
  assert.ok(compiled.confident, `${question} should be answered by the rules`);
  return { compiled, result: executePlan(compiled.plan, table, rows) };
}

test('show data for only id → just the ID columns, every row', () => {
  const { compiled, result } = project('show data for only id');
  assert.deepEqual(compiled.plan.columns, ['Product ID', 'Supplier ID']);
  assert.equal(tableHeader(result.answer), '| # | Product ID | Supplier ID |');
  assert.equal(result.indexes.length, 46);
  assert.match(result.answer, /\| 46 \| P1046 \| S11 \|/); // all 46 rows are shown, not the first 40
});

test('one named column', () => {
  for (const question of [
    'show only product name',
    'list product names',
    'give me the unit price column',
  ]) {
    const { compiled } = project(question);
    assert.equal(compiled.plan.columns.length, 1, question);
  }
  assert.deepEqual(project('show only product name').compiled.plan.columns, ['Product Name']);
  assert.deepEqual(project('give me the unit price column').compiled.plan.columns, ['Unit Price']);
});

test('several columns keep the order of the question', () => {
  assert.deepEqual(project('show product name and category').compiled.plan.columns, [
    'Product Name',
    'Category',
  ]);
  assert.deepEqual(project('product id and price kaattu').compiled.plan.columns, [
    'Product ID',
    'Unit Price',
  ]);
  assert.deepEqual(project('show names and suppliers mattum').compiled.plan.columns, [
    'Product Name',
    'Supplier',
  ]);
});

test('projection works together with a filter', () => {
  const { compiled, result } = project('show only id for Electronics');
  assert.deepEqual(compiled.plan.filters, [
    { column: 'Category', op: 'equals', value: 'Electronics' },
  ]);
  assert.equal(result.indexes.length, rows.filter((r) => r[2] === 'Electronics').length);
  assert.equal(tableHeader(result.answer), '| # | Product ID | Supplier ID |');
  assert.match(result.answer, /Filter: Category = Electronics/);
});

test('questions that only look similar are not projections', () => {
  // distinct values, full rows, and sorted top-N keep their old meaning
  assert.equal(compile('list all categories').plan.operation, 'group_count');
  assert.equal(compile('show items in Electronics').plan.columns, undefined);
  assert.equal(compile('top 5 unit price').plan.columns, undefined);
  assert.equal(compile('show all products').confident, false);
  assert.equal(compile('how many products in Furniture').plan.columns, undefined);
});
