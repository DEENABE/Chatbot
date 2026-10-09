import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCells,
  formatCell,
  hasMarkdownTable,
  isNumericCell,
  splitMarkdownTables,
  tableToCsv,
  tableToTsv,
} from './markdownTables.js';

const ANSWER = [
  '**Inventory.xlsx › Data**',
  '',
  'Filter: Product Name contains Laptop, Monitor  ',
  '**2 matching rows** out of 46',
  '',
  '| # | Product ID | Product Name | Cost Price Total (USD) |',
  '| --- | --- | --- | --- |',
  '| 1 | P101 | Laptop | 72000 |',
  '| 2 | P102 | Monitor | 25000 |',
  '',
  'Showing the first 2 of 2 matching rows.',
].join('\n');

test('a markdown table is split from the text around it', () => {
  const parts = splitMarkdownTables(ANSWER);
  assert.deepEqual(
    parts.map((p) => p.type),
    ['text', 'table', 'text'],
  );
  const table = parts[1];
  assert.deepEqual(table.header, ['#', 'Product ID', 'Product Name', 'Cost Price Total (USD)']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[1], ['2', 'P102', 'Monitor', '25000']);
  assert.match(parts[0].text, /2 matching rows/);
  assert.match(parts[2].text, /Showing the first 2/);
  assert.ok(hasMarkdownTable(ANSWER));
});

test('windows line endings, escaped pipes, ragged rows and alignment', () => {
  const text = '| A | B |\r\n|:---|---:|\r\n| x \\| y | 1 |\r\n| only-one |\r\n';
  const [table] = splitMarkdownTables(text);
  assert.equal(table.type, 'table');
  assert.deepEqual(table.aligns, ['left', 'right']);
  assert.deepEqual(table.rows[0], ['x | y', '1']);
  assert.deepEqual(table.rows[1], ['only-one', '']);
});

test('tables inside code fences and ordinary text are left alone', () => {
  const fenced = '```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```';
  assert.ok(!hasMarkdownTable(fenced));
  assert.ok(!hasMarkdownTable('a | b is not a table\n---\nnext'));
  assert.ok(!hasMarkdownTable(''));
  assert.ok(!hasMarkdownTable(undefined));
});

test('two tables in one message stay separate', () => {
  const text =
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext between\n\n| c | d |\n| --- | --- |\n| 3 | 4 |';
  assert.deepEqual(
    splitMarkdownTables(text).map((p) => p.type),
    ['table', 'text', 'table'],
  );
});

test('numbers: grouping only for plain amounts, never for ids or phones', () => {
  assert.equal(formatCell('Cost Price Total (USD)', '72000', true), '72,000');
  assert.equal(formatCell('Salary', '213000.50', true), '213,000.50');
  assert.equal(formatCell('Units', '950', true), '950');
  assert.equal(formatCell('Phone', '9579261983', true), '9579261983');
  assert.equal(formatCell('Emp ID', '100200', true), '100200');
  assert.equal(formatCell('Pin Code', '600001', true), '600001');
  assert.equal(formatCell('Amount', '007500', true), '007500');
  assert.equal(formatCell('Name', '72000', false), '72000');
  assert.ok(isNumericCell('₹ 1,200.50') && isNumericCell('45%') && !isNumericCell('P101'));
});

test('sorting is numeric for numbers, natural for text, blanks last', () => {
  assert.ok(compareCells('9', '10') < 0);
  assert.ok(compareCells('1,200', '300') > 0);
  assert.ok(compareCells('P2', 'P10') < 0);
  assert.ok(compareCells('', 'a') > 0);
  assert.ok(compareCells('a', '') < 0);
});

test('copy and CSV exports keep the raw values', () => {
  const header = ['Name', 'Note'];
  const rows = [
    ['Ravi', 'said "hi", left'],
    ['Asha', 'line\nbreak'],
  ];
  const csv = tableToCsv(header, rows);
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /"Ravi","said ""hi"", left"/);
  assert.equal(tableToTsv(header, rows), 'Name\tNote\nRavi\tsaid "hi", left\nAsha\tline break');
});
