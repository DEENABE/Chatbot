// node --test src/docqa/questionCompiler.test.js   (from backend/)
//
// Accuracy suite for spreadsheet Q&A: ~100 English / Tanglish questions asked over THREE
// tables at once (employees + visitors + inventory), each checked against an answer that
// is computed independently from the raw rows. Also checks that bad model-written plans are
// repaired (wrong column, misspelt value, forgotten filter, wrong operation).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTable } from './tableParser.js';
import { compileQuestion, profileTable, repairPlan } from './questionCompiler.js';
import { executePlan } from './queryPlanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoXlsx = path.resolve(here, '../../../demo-data/employees.xlsx');
const NOW = new Date(Date.UTC(2026, 9, 8));

// ───────────────────────── data ─────────────────────────
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const isoDate = (y0, y1) => {
  const y = y0 + Math.floor(rnd() * (y1 - y0 + 1));
  return `${y}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
};

async function loadEmployees() {
  if (fs.existsSync(demoXlsx)) {
    const { parseSpreadsheet } = await import('./tableParser.js');
    const [t] = await parseSpreadsheet(demoXlsx, '.xlsx');
    return { columns: t.columns, rows: t.rows };
  }
  // Same shape as demo-data/employees.xlsx when the file is not available.
  const cities = [
    'Chennai',
    'Madurai',
    'Coimbatore',
    'Salem',
    'Bengaluru',
    'Hyderabad',
    'Pune',
    'Trichy',
  ];
  const companies = [
    'TCS',
    'Infosys',
    'Wipro',
    'Zoho',
    'Cognizant',
    'HCL',
    'Accenture',
    'Capgemini',
    'Freshworks',
    'Mphasis',
  ];
  const depts = ['Engineering', 'Operations', 'HR', 'Finance', 'Sales', 'Support'];
  const first = [
    'Rajesh',
    'Kavya',
    'Karthik',
    'Priya',
    'Divya',
    'Arun',
    'Meena',
    'Suresh',
    'Anitha',
    'Vignesh',
  ];
  const last = ['Subramanian', 'Shankar', 'Krishnan', 'Iyer', 'Raman', 'Selvam', 'Nair', 'Kumar'];
  const rows = Array.from({ length: 520 }, (_, i) => {
    const name = `${pick(first)} ${pick(last)}`;
    return [
      `EMP${1001 + i}`,
      name,
      `${name.toLowerCase().replace(/ /g, '.')}${i + 1}@example.com`,
      String(9000000000 + Math.floor(rnd() * 999999999)),
      pick(cities),
      pick(companies),
      pick(depts),
      isoDate(2014, 2025),
      String(40000 + Math.floor(rnd() * 160) * 1000),
      pick(['Active', 'Active', 'Active', 'Resigned', 'On Leave']),
    ];
  });
  return {
    columns: [
      'Emp ID',
      'Name',
      'Email',
      'Phone',
      'City',
      'Company',
      'Department',
      'Joining Date',
      'Salary',
      'Status',
    ],
    rows,
  };
}

const emp = await loadEmployees();
const E = emp.rows.map((r, idx) => ({
  idx,
  id: r[0],
  name: r[1],
  email: r[2],
  phone: r[3],
  city: r[4],
  company: r[5],
  dept: r[6],
  joined: r[7],
  salary: Number(r[8]),
  status: r[9],
}));

const purposes = ['Interview', 'Meeting', 'Delivery', 'Maintenance', 'Audit'];
const hosts = [
  'Anand Kumar',
  'Bhavani Rao',
  'Chitra Devi',
  'Dinesh Babu',
  'Esha Menon',
  'Farook Ali',
];
const visitCompanies = ['Infosys', 'Zoho', 'Dell', 'HP', 'Lenovo', 'Reliance'];
const visitors = {
  columns: ['Visitor ID', 'Visitor Name', 'Company', 'Purpose', 'Host', 'Visit Date', 'Phone'],
  rows: Array.from({ length: 150 }, (_, i) => [
    `V${2001 + i}`,
    `${pick(['Mohan', 'Latha', 'Gopal', 'Sneha', 'Bala', 'Nithya', 'Harish', 'Pooja'])} ${pick(['Raj', 'Das', 'Varma', 'Pillai', 'Gupta', 'Reddy'])}`,
    pick(visitCompanies),
    pick(purposes),
    pick(hosts),
    isoDate(2025, 2026),
    String(8000000000 + Math.floor(rnd() * 999999999)),
  ]),
};
const V = visitors.rows.map((r, idx) => ({
  idx,
  id: r[0],
  name: r[1],
  company: r[2],
  purpose: r[3],
  host: r[4],
  date: r[5],
}));

const productNames = [
  'Laptop',
  'Monitor',
  'Keyboard',
  'Headphones',
  'Mouse',
  'Webcam',
  'Printer',
  'Router',
];
const productCategory = {
  Laptop: 'Computers',
  Monitor: 'Computers',
  Printer: 'Computers',
  Keyboard: 'Accessories',
  Headphones: 'Accessories',
  Mouse: 'Accessories',
  Webcam: 'Accessories',
  Router: 'Networking',
};
const inventory = {
  columns: [
    'Product ID',
    'Product Name',
    'Category',
    'Quantity',
    'Unit Price',
    'Supplier',
    'Warehouse',
    'Last Restocked',
  ],
  rows: Array.from({ length: 46 }, (_, i) => {
    const name = productNames[i % productNames.length];
    return [
      `P${1001 + i}`,
      name,
      productCategory[name],
      String(5 + Math.floor(rnd() * 200)),
      String(500 + (Math.floor(rnd() * 90) * 1000) / 10),
      pick(['Dell', 'HP', 'Logitech', 'Lenovo', 'Cisco']),
      pick(['Chennai', 'Mumbai', 'Delhi']),
      isoDate(2025, 2026),
    ];
  }),
};
const I = inventory.rows.map((r, idx) => ({
  idx,
  id: r[0],
  name: r[1],
  cat: r[2],
  qty: Number(r[3]),
  price: Number(r[4]),
  supplier: r[5],
  wh: r[6],
  restocked: r[7],
}));

const tables = [
  { filename: 'employees.xlsx', sheet: 'Employees', columns: emp.columns, rows: emp.rows },
  { filename: 'visitors.xlsx', sheet: 'Visitors', columns: visitors.columns, rows: visitors.rows },
  {
    filename: 'Inventory-Records-Sample-Data.xlsx',
    sheet: 'Inventory Records Data',
    columns: inventory.columns,
    rows: inventory.rows,
  },
].map((t) => ({
  table: {
    id: t.sheet,
    filename: t.filename,
    sheet: t.sheet,
    columns: t.columns,
    rowCount: t.rows.length,
  },
  rows: t.rows,
}));
const EMP = 0;
const VIS = 1;
const INV = 2;

// ───────────────────────── harness ─────────────────────────
function ask(question, candidates = tables) {
  const compiled = compileQuestion(question, candidates, { now: NOW });
  const target = candidates[compiled.tableIndex ?? 0];
  const res = compiled.plan ? executePlan(compiled.plan, target.table, target.rows) : null;
  return { compiled, res, plan: compiled.plan, tableIndex: compiled.tableIndex };
}
const sameSet = (a, b) =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const idxOf = (list, fn) => list.filter(fn).map((x) => x.idx);
const groupMap = (res) =>
  Object.fromEntries(
    (res.groups || []).map((g) => (Array.isArray(g) ? [g[0], g[1]] : [g.key, g.value])),
  );
function tally(list, keyFn) {
  const m = {};
  for (const x of list) m[keyFn(x)] = (m[keyFn(x)] || 0) + 1;
  return m;
}
function groupedStat(list, keyFn, valFn, kind) {
  const buckets = {};
  for (const x of list) (buckets[keyFn(x)] ||= []).push(valFn(x));
  const out = {};
  for (const [k, v] of Object.entries(buckets)) {
    const s = v.reduce((a, b) => a + b, 0);
    out[k] =
      Math.round(
        (kind === 'avg'
          ? s / v.length
          : kind === 'sum'
            ? s
            : kind === 'max'
              ? Math.max(...v)
              : Math.min(...v)) * 100,
      ) / 100;
  }
  return out;
}
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const results = [];
function check(question, expectation) {
  test(question, () => {
    let ok = false;
    try {
      const out = ask(question);
      expectation(out);
      ok = true;
    } finally {
      results.push({ question, ok });
    }
  });
}
/** Asserts the compiler was sure, picked the right table and the rows match exactly. */
function rows(question, table, expectedIdx, op = null) {
  check(question, ({ compiled, res, tableIndex }) => {
    assert.equal(
      compiled.kind,
      'analytic',
      `kind=${compiled.kind} unexplained=${compiled.unexplained}`,
    );
    assert.ok(
      compiled.confident,
      `not confident, unexplained=${JSON.stringify(compiled.unexplained)} plan=${JSON.stringify(compiled.plan)}`,
    );
    assert.equal(tableIndex, table, `wrong table ${tableIndex}`);
    if (op) assert.equal(compiled.plan.operation, op, JSON.stringify(compiled.plan));
    assert.ok(
      sameSet(res.indexes, expectedIdx),
      `rows ${res.indexes.length} vs expected ${expectedIdx.length}; plan=${JSON.stringify(compiled.plan)}`,
    );
  });
}
function value(question, table, expected, op) {
  check(question, ({ compiled, res, tableIndex }) => {
    assert.ok(
      compiled.confident,
      `not confident, unexplained=${JSON.stringify(compiled.unexplained)} plan=${JSON.stringify(compiled.plan)}`,
    );
    assert.equal(tableIndex, table);
    assert.equal(compiled.plan.operation, op, JSON.stringify(compiled.plan));
    assert.equal(res.value, expected, JSON.stringify(compiled.plan));
  });
}
function groups(question, table, expected, op) {
  check(question, ({ compiled, res, tableIndex }) => {
    assert.ok(
      compiled.confident,
      `not confident, unexplained=${JSON.stringify(compiled.unexplained)} plan=${JSON.stringify(compiled.plan)}`,
    );
    assert.equal(tableIndex, table);
    assert.equal(compiled.plan.operation, op, JSON.stringify(compiled.plan));
    assert.deepEqual(groupMap(res), expected, JSON.stringify(compiled.plan));
  });
}
function top(question, table, expectedKeys, op) {
  check(question, ({ compiled, res, tableIndex }) => {
    assert.ok(
      compiled.confident,
      `not confident, unexplained=${JSON.stringify(compiled.unexplained)} plan=${JSON.stringify(compiled.plan)}`,
    );
    assert.equal(tableIndex, table);
    assert.equal(compiled.plan.operation, op, JSON.stringify(compiled.plan));
    const first = res.groups[0];
    const key = Array.isArray(first) ? first[0] : first.key;
    assert.ok(expectedKeys.includes(key), `top group ${key} not in ${expectedKeys}`);
  });
}
function notAnalytic(question, kinds = ['lookup', 'unknown']) {
  check(question, ({ compiled }) => {
    assert.ok(
      kinds.includes(compiled.kind) && !(compiled.kind === 'analytic' && compiled.confident),
      `kind=${compiled.kind} confident=${compiled.confident} plan=${JSON.stringify(compiled.plan)}`,
    );
  });
}

// ───────────────────────── counts & filters ─────────────────────────
const inCity = (c) => (e) => e.city === c;
rows('how many employees are in Chennai', EMP, idxOf(E, inCity('Chennai')), 'count');
rows('Chennai la ethana per irukaanga', EMP, idxOf(E, inCity('Chennai')), 'count');
rows('chennai employees count', EMP, idxOf(E, inCity('Chennai')), 'count');
rows('CHENNAI ku evlo employees', EMP, idxOf(E, inCity('Chennai')), 'count');
rows(
  'how many people work in TCS',
  EMP,
  idxOf(E, (e) => e.company === 'TCS'),
  'count',
);
rows(
  'Infosys company employees count',
  EMP,
  idxOf(E, (e) => e.company === 'Infosys'),
  'count',
);
rows(
  'how many Active employees',
  EMP,
  idxOf(E, (e) => e.status === 'Active'),
  'count',
);
rows(
  'how many resigned employees are there',
  EMP,
  idxOf(E, (e) => e.status === 'Resigned'),
  'count',
);
rows(
  'number of employees in Chennai and Infosys',
  EMP,
  idxOf(E, (e) => e.city === 'Chennai' && e.company === 'Infosys'),
  'count',
);
rows(
  'how many employees in Engineering department',
  EMP,
  idxOf(E, (e) => e.dept === 'Engineering'),
  'count',
);
rows(
  'Chennai or Madurai la evlo per',
  EMP,
  idxOf(E, (e) => e.city === 'Chennai' || e.city === 'Madurai'),
  'count',
);
rows(
  'how many employees are not in Chennai',
  EMP,
  idxOf(E, (e) => e.city !== 'Chennai'),
  'count',
);
rows(
  'Chennai thavira ethana employees',
  EMP,
  idxOf(E, (e) => e.city !== 'Chennai'),
  'count',
);
rows(
  'how many employees joined in 2023',
  EMP,
  idxOf(E, (e) => e.joined.startsWith('2023')),
  'count',
);
rows(
  'how many joined after 2020',
  EMP,
  idxOf(E, (e) => e.joined > '2020-12-31'),
  'count',
);
rows(
  'how many employees joined before 2018',
  EMP,
  idxOf(E, (e) => e.joined < '2018-01-01'),
  'count',
);
rows(
  'employees joined since 2022 count',
  EMP,
  idxOf(E, (e) => e.joined >= '2022-01-01'),
  'count',
);
rows(
  'employees joined between 2018 and 2020 count',
  EMP,
  idxOf(E, (e) => e.joined >= '2018-01-01' && e.joined <= '2020-12-31'),
  'count',
);
rows(
  'how many employees have salary above 150000',
  EMP,
  idxOf(E, (e) => e.salary > 150000),
  'count',
);
rows(
  'salary more than 1.5 lakh evlo per',
  EMP,
  idxOf(E, (e) => e.salary > 150000),
  'count',
);
rows(
  'how many employees earn less than 80k',
  EMP,
  idxOf(E, (e) => e.salary < 80000),
  'count',
);
rows(
  'sambalam 100000 ku mela ethana per',
  EMP,
  idxOf(E, (e) => e.salary > 100000),
  'count',
);
rows(
  'salary between 50000 and 100000 count',
  EMP,
  idxOf(E, (e) => e.salary >= 50000 && e.salary <= 100000),
  'count',
);
rows(
  'how many Active employees in Chennai joined after 2019',
  EMP,
  idxOf(E, (e) => e.status === 'Active' && e.city === 'Chennai' && e.joined > '2019-12-31'),
  'count',
);
rows(
  'TCS la Active ah irukkura employees ethana',
  EMP,
  idxOf(E, (e) => e.company === 'TCS' && e.status === 'Active'),
  'count',
);
rows(
  'how many employees joined in last 2 years',
  EMP,
  idxOf(E, (e) => e.joined >= '2024-10-08'),
  'count',
);
rows(
  'how many employees in Infosys earn more than 100000',
  EMP,
  idxOf(E, (e) => e.company === 'Infosys' && e.salary > 100000),
  'count',
);

// ───────────────────────── lists ─────────────────────────
rows('list all employees in Madurai', EMP, idxOf(E, inCity('Madurai')), 'list');
rows(
  'show Infosys employees from Chennai',
  EMP,
  idxOf(E, (e) => e.company === 'Infosys' && e.city === 'Chennai'),
  'list',
);
rows(
  'Chennai employees joined in 2022',
  EMP,
  idxOf(E, (e) => e.city === 'Chennai' && e.joined.startsWith('2022')),
  'list',
);
rows(
  'Active employees in Operations',
  EMP,
  idxOf(E, (e) => e.status === 'Active' && e.dept === 'Operations'),
  'list',
);
rows(
  'Zoho la irukkura Engineering aalga list pannu',
  EMP,
  idxOf(E, (e) => e.company === 'Zoho' && e.dept === 'Engineering'),
  'list',
);

// ───────────────────────── aggregates ─────────────────────────
value('total salary', EMP, sum(E.map((e) => e.salary)), 'sum');
value('average salary', EMP, round2(sum(E.map((e) => e.salary)) / E.length), 'avg');
value(
  'average salary of Chennai employees',
  EMP,
  round2(
    sum(E.filter(inCity('Chennai')).map((e) => e.salary)) / E.filter(inCity('Chennai')).length,
  ),
  'avg',
);
value('highest salary', EMP, Math.max(...E.map((e) => e.salary)), 'max');
value(
  'lowest salary in TCS',
  EMP,
  Math.min(...E.filter((e) => e.company === 'TCS').map((e) => e.salary)),
  'min',
);
value(
  'total salary paid to Engineering department',
  EMP,
  sum(E.filter((e) => e.dept === 'Engineering').map((e) => e.salary)),
  'sum',
);
value(
  'what is the average salary in Infosys in Bengaluru',
  EMP,
  round2(
    sum(E.filter((e) => e.company === 'Infosys' && e.city === 'Bengaluru').map((e) => e.salary)) /
      E.filter((e) => e.company === 'Infosys' && e.city === 'Bengaluru').length,
  ),
  'avg',
);
value(
  'maximum salary of Active employees',
  EMP,
  Math.max(...E.filter((e) => e.status === 'Active').map((e) => e.salary)),
  'max',
);
value('sambalam average evlo', EMP, round2(sum(E.map((e) => e.salary)) / E.length), 'avg');
value(
  'Wipro employees mothama sambalam',
  EMP,
  sum(E.filter((e) => e.company === 'Wipro').map((e) => e.salary)),
  'sum',
);
value(
  'total quantity of Laptop',
  INV,
  sum(I.filter((x) => x.name === 'Laptop').map((x) => x.qty)),
  'sum',
);
value(
  'average unit price of Monitor',
  INV,
  round2(
    sum(I.filter((x) => x.name === 'Monitor').map((x) => x.price)) /
      I.filter((x) => x.name === 'Monitor').length,
  ),
  'avg',
);
value(
  'total stock in Chennai warehouse',
  INV,
  sum(I.filter((x) => x.wh === 'Chennai').map((x) => x.qty)),
  'sum',
);

// ───────────────────────── group by ─────────────────────────
groups(
  'employees company wise count',
  EMP,
  tally(E, (e) => e.company),
  'group_count',
);
groups(
  'city wise employees count',
  EMP,
  tally(E, (e) => e.city),
  'group_count',
);
groups(
  'department wise count',
  EMP,
  tally(E, (e) => e.dept),
  'group_count',
);
groups(
  'status wise count',
  EMP,
  tally(E, (e) => e.status),
  'group_count',
);
groups(
  'average salary per department',
  EMP,
  groupedStat(
    E,
    (e) => e.dept,
    (e) => e.salary,
    'avg',
  ),
  'avg',
);
groups(
  'company wise total salary',
  EMP,
  groupedStat(
    E,
    (e) => e.company,
    (e) => e.salary,
    'sum',
  ),
  'sum',
);
groups(
  'city wise average salary',
  EMP,
  groupedStat(
    E,
    (e) => e.city,
    (e) => e.salary,
    'avg',
  ),
  'avg',
);
groups(
  'number of employees per company in Chennai',
  EMP,
  tally(E.filter(inCity('Chennai')), (e) => e.company),
  'group_count',
);
groups(
  'department wise count of Active employees',
  EMP,
  tally(
    E.filter((e) => e.status === 'Active'),
    (e) => e.dept,
  ),
  'group_count',
);
groups(
  'highest salary in each department',
  EMP,
  groupedStat(
    E,
    (e) => e.dept,
    (e) => e.salary,
    'max',
  ),
  'max',
);
groups(
  'purpose wise visitors count',
  VIS,
  tally(V, (v) => v.purpose),
  'group_count',
);
groups(
  'host wise visitor count',
  VIS,
  tally(V, (v) => v.host),
  'group_count',
);
groups(
  'product wise total quantity',
  INV,
  groupedStat(
    I,
    (x) => x.name,
    (x) => x.qty,
    'sum',
  ),
  'sum',
);
groups(
  'category wise count of products',
  INV,
  tally(I, (x) => x.cat),
  'group_count',
);

// ───────────────────────── rank ("which X has the most") ─────────────────────────
const maxKeys = (m) => Object.keys(m).filter((k) => m[k] === Math.max(...Object.values(m)));
const minKeys = (m) => Object.keys(m).filter((k) => m[k] === Math.min(...Object.values(m)));
top('which city has the most employees', EMP, maxKeys(tally(E, (e) => e.city)), 'group_count');
top(
  'which company has the least employees',
  EMP,
  minKeys(tally(E, (e) => e.company)),
  'group_count',
);
top(
  'which department has the highest average salary',
  EMP,
  maxKeys(
    groupedStat(
      E,
      (e) => e.dept,
      (e) => e.salary,
      'avg',
    ),
  ),
  'avg',
);
top('most common city', EMP, maxKeys(tally(E, (e) => e.city)), 'group_count');
top(
  'which company has the highest total salary',
  EMP,
  maxKeys(
    groupedStat(
      E,
      (e) => e.company,
      (e) => e.salary,
      'sum',
    ),
  ),
  'sum',
);
top('which host met the most visitors', VIS, maxKeys(tally(V, (v) => v.host)), 'group_count');

// ───────────────────────── top-N / latest ─────────────────────────
check('top 5 highest salary employees', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(compiled.plan.sortDir, 'desc');
  assert.equal(compiled.plan.limit, 5);
  assert.deepEqual(
    res.indexes.slice(0, 5).map((i) => E[i].salary),
    [...E]
      .sort((a, b) => b.salary - a.salary)
      .slice(0, 5)
      .map((e) => e.salary),
  );
});
check('5 lowest paid employees', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(
    res.indexes.slice(0, 5).map((i) => E[i].salary),
    [...E]
      .sort((a, b) => a.salary - b.salary)
      .slice(0, 5)
      .map((e) => e.salary),
  );
});
check('latest joined employees', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(
    E[res.indexes[0]].joined,
    [...E].sort((a, b) => b.joined.localeCompare(a.joined))[0].joined,
  );
});
check('oldest employee by joining date', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(
    E[res.indexes[0]].joined,
    [...E].sort((a, b) => a.joined.localeCompare(b.joined))[0].joined,
  );
});
check('top 3 salary in Chennai', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  const expected = E.filter(inCity('Chennai'))
    .sort((a, b) => b.salary - a.salary)
    .slice(0, 3)
    .map((e) => e.salary);
  assert.deepEqual(
    res.indexes.slice(0, 3).map((i) => E[i].salary),
    expected,
  );
});
check('who has the highest salary', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(res.value, Math.max(...E.map((e) => e.salary)));
});

// ───────────────────────── distinct values ─────────────────────────
check('list all cities', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(Object.keys(groupMap(res)).sort(), Object.keys(tally(E, (e) => e.city)).sort());
});
check('how many companies are there in employees', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(res.value, new Set(E.map((e) => e.company)).size);
});
check('unique departments', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(Object.keys(groupMap(res)).sort(), Object.keys(tally(E, (e) => e.dept)).sort());
});
check('ethana cities irukku', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(res.value, new Set(E.map((e) => e.city)).size);
});

// ───────────────────────── other tables ─────────────────────────
rows(
  'how many visitors came for Interview',
  VIS,
  idxOf(V, (v) => v.purpose === 'Interview'),
  'count',
);
rows(
  'Infosys visitors count',
  VIS,
  idxOf(V, (v) => v.company === 'Infosys'),
  'count',
);
rows(
  'audit visitors met Anand Kumar',
  VIS,
  idxOf(V, (v) => v.purpose === 'Audit' && v.host === 'Anand Kumar'),
  'list',
);
rows(
  'visitors in 2026',
  VIS,
  idxOf(V, (v) => v.date.startsWith('2026')),
  'list',
);
rows(
  'how many products in Chennai warehouse',
  INV,
  idxOf(I, (x) => x.wh === 'Chennai'),
  'count',
);
rows(
  'Laptop, Monitor, Keyboard stock list',
  INV,
  idxOf(I, (x) => ['Laptop', 'Monitor', 'Keyboard'].includes(x.name)),
  'list',
);
rows(
  'products with quantity below 20',
  INV,
  idxOf(I, (x) => x.qty < 20),
  'list',
);
rows(
  'how many Accessories',
  INV,
  idxOf(I, (x) => x.cat === 'Accessories'),
  'count',
);
rows(
  'Dell supplier products count',
  INV,
  idxOf(I, (x) => x.supplier === 'Dell'),
  'count',
);

// ───────────────────────── second set: phrasing written AFTER the first run (hold-out) ─────────────────────────
rows('show me all employees from Salem', EMP, idxOf(E, inCity('Salem')), 'list');
rows(
  'give me the list of people who joined in 2021',
  EMP,
  idxOf(E, (e) => e.joined.startsWith('2021')),
  'list',
);
rows(
  'who joined after Jan 2022',
  EMP,
  idxOf(E, (e) => e.joined > '2022-01-31'),
  'list',
);
rows(
  'employees with salary greater than 180000',
  EMP,
  idxOf(E, (e) => e.salary > 180000),
  'list',
);
rows(
  'salary 120000 ku keela ullavanga yaar yaar',
  EMP,
  idxOf(E, (e) => e.salary < 120000),
  'list',
);
rows(
  'how many employees are there in total',
  EMP,
  idxOf(E, () => true),
  'count',
);
rows(
  'Bengaluru la Wipro la irukkuravanga list',
  EMP,
  idxOf(E, (e) => e.city === 'Bengaluru' && e.company === 'Wipro'),
  'list',
);
rows(
  'employees in Pune or Hyderabad',
  EMP,
  idxOf(E, (e) => e.city === 'Pune' || e.city === 'Hyderabad'),
  'list',
);
rows(
  'all resigned employees from TCS',
  EMP,
  idxOf(E, (e) => e.status === 'Resigned' && e.company === 'TCS'),
  'list',
);
rows(
  'show employees on leave',
  EMP,
  idxOf(E, (e) => e.status === 'On Leave'),
  'list',
);
rows(
  'employees joined in March 2021',
  EMP,
  idxOf(E, (e) => e.joined.startsWith('2021-03')),
  'list',
);
rows(
  'how many employees earn more than 1 lakh',
  EMP,
  idxOf(E, (e) => e.salary > 100000),
  'count',
);
rows(
  'salary >= 150000 count',
  EMP,
  idxOf(E, (e) => e.salary >= 150000),
  'count',
);
rows(
  'employees who earn between 90k and 120k',
  EMP,
  idxOf(E, (e) => e.salary >= 90000 && e.salary <= 120000),
  'list',
);
rows(
  'TCS and Infosys employees count',
  EMP,
  idxOf(E, (e) => e.company === 'TCS' || e.company === 'Infosys'),
  'count',
);
rows(
  'TCS employees in Chennai and Madurai',
  EMP,
  idxOf(E, (e) => e.company === 'TCS' && (e.city === 'Chennai' || e.city === 'Madurai')),
  'list',
);
rows(
  'Finance department employees count in Trichy',
  EMP,
  idxOf(E, (e) => e.dept === 'Finance' && e.city === 'Trichy'),
  'count',
);
rows(
  'salary 50000 ku kammiya irukkuravanga ethana per',
  EMP,
  idxOf(E, (e) => e.salary < 50000),
  'count',
);
rows('Chennai la irukkura employees ellam list pannu', EMP, idxOf(E, inCity('Chennai')), 'list');
rows('how many employes in Chenai', EMP, idxOf(E, inCity('Chennai')), 'count');
rows(
  'Active employees who joined before 2016',
  EMP,
  idxOf(E, (e) => e.status === 'Active' && e.joined < '2016-01-01'),
  'list',
);
rows(
  'how many HR employees are resigned',
  EMP,
  idxOf(E, (e) => e.dept === 'HR' && e.status === 'Resigned'),
  'count',
);
rows(
  'Support team members in Coimbatore',
  EMP,
  idxOf(E, (e) => e.dept === 'Support' && e.city === 'Coimbatore'),
  'list',
);
rows(
  'how many employees do not belong to TCS',
  EMP,
  idxOf(E, (e) => e.company !== 'TCS'),
  'count',
);
rows(
  'employees except Resigned',
  EMP,
  idxOf(E, (e) => e.status !== 'Resigned'),
  'list',
);
value(
  'what is the total salary of all employees in HR department',
  EMP,
  sum(E.filter((e) => e.dept === 'HR').map((e) => e.salary)),
  'sum',
);
value(
  'average salary of resigned employees',
  EMP,
  round2(
    sum(E.filter((e) => e.status === 'Resigned').map((e) => e.salary)) /
      E.filter((e) => e.status === 'Resigned').length,
  ),
  'avg',
);
value('minimum salary', EMP, Math.min(...E.map((e) => e.salary)), 'min');
value(
  'highest paid employee in Chennai',
  EMP,
  Math.max(...E.filter(inCity('Chennai')).map((e) => e.salary)),
  'max',
);
value(
  'what is the avg sambalam in Zoho',
  EMP,
  round2(
    sum(E.filter((e) => e.company === 'Zoho').map((e) => e.salary)) /
      E.filter((e) => e.company === 'Zoho').length,
  ),
  'avg',
);
value(
  'sum of salary for Active employees in Pune',
  EMP,
  sum(E.filter((e) => e.status === 'Active' && e.city === 'Pune').map((e) => e.salary)),
  'sum',
);
value('total quantity in stock', INV, sum(I.map((x) => x.qty)), 'sum');
value(
  'average quantity of Keyboard',
  INV,
  round2(
    sum(I.filter((x) => x.name === 'Keyboard').map((x) => x.qty)) /
      I.filter((x) => x.name === 'Keyboard').length,
  ),
  'avg',
);
value('highest unit price', INV, Math.max(...I.map((x) => x.price)), 'max');
groups(
  'count of employees in each city',
  EMP,
  tally(E, (e) => e.city),
  'group_count',
);
groups(
  'number of active employees in each department',
  EMP,
  tally(
    E.filter((e) => e.status === 'Active'),
    (e) => e.dept,
  ),
  'group_count',
);
groups(
  'company wise average salary of employees',
  EMP,
  groupedStat(
    E,
    (e) => e.company,
    (e) => e.salary,
    'avg',
  ),
  'avg',
);
groups(
  'number of resigned employees by company',
  EMP,
  tally(
    E.filter((e) => e.status === 'Resigned'),
    (e) => e.company,
  ),
  'group_count',
);
groups(
  'employees count by department',
  EMP,
  tally(E, (e) => e.dept),
  'group_count',
);
groups(
  'group employees by city',
  EMP,
  tally(E, (e) => e.city),
  'group_count',
);
groups(
  'total salary by status',
  EMP,
  groupedStat(
    E,
    (e) => e.status,
    (e) => e.salary,
    'sum',
  ),
  'sum',
);
groups(
  'minimum salary per city',
  EMP,
  groupedStat(
    E,
    (e) => e.city,
    (e) => e.salary,
    'min',
  ),
  'min',
);
groups(
  'supplier wise product count',
  INV,
  tally(I, (x) => x.supplier),
  'group_count',
);
groups(
  'warehouse wise total quantity',
  INV,
  groupedStat(
    I,
    (x) => x.wh,
    (x) => x.qty,
    'sum',
  ),
  'sum',
);
groups(
  'visitors count by company',
  VIS,
  tally(V, (v) => v.company),
  'group_count',
);
top(
  'company with highest number of employees',
  EMP,
  maxKeys(tally(E, (e) => e.company)),
  'group_count',
);
top('which city has fewest people', EMP, minKeys(tally(E, (e) => e.city)), 'group_count');
top(
  'department with lowest average salary',
  EMP,
  minKeys(
    groupedStat(
      E,
      (e) => e.dept,
      (e) => e.salary,
      'avg',
    ),
  ),
  'avg',
);
top(
  'which warehouse has the most stock',
  INV,
  maxKeys(
    groupedStat(
      I,
      (x) => x.wh,
      (x) => x.qty,
      'sum',
    ),
  ),
  'sum',
);
check('top 10 salaries', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(compiled.plan.limit, 10);
  assert.deepEqual(
    res.indexes.slice(0, 10).map((i) => E[i].salary),
    [...E]
      .sort((a, b) => b.salary - a.salary)
      .slice(0, 10)
      .map((e) => e.salary),
  );
});
check('who are the 3 highest paid employees in Zoho', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(
    res.indexes.slice(0, 3).map((i) => E[i].salary),
    E.filter((e) => e.company === 'Zoho')
      .sort((a, b) => b.salary - a.salary)
      .slice(0, 3)
      .map((e) => e.salary),
  );
});
check('last 3 employees who joined', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(
    res.indexes.slice(0, 3).map((i) => E[i].joined),
    [...E]
      .sort((a, b) => b.joined.localeCompare(a.joined))
      .slice(0, 3)
      .map((e) => e.joined),
  );
});
check('oldest joined employee in Accenture', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(
    E[res.indexes[0]].joined,
    E.filter((e) => e.company === 'Accenture').sort((a, b) => a.joined.localeCompare(b.joined))[0]
      .joined,
  );
});
check('show unique statuses', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.deepEqual(
    Object.keys(groupMap(res)).sort(),
    Object.keys(tally(E, (e) => e.status)).sort(),
  );
});
check('distinct cities count', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(res.value, new Set(E.map((e) => e.city)).size);
});
check('ethana companies irukku employees la', ({ compiled, res, tableIndex }) => {
  assert.ok(compiled.confident, JSON.stringify(compiled.unexplained));
  assert.equal(tableIndex, EMP);
  assert.equal(res.value, new Set(E.map((e) => e.company)).size);
});
rows(
  'Anand Kumar host panna visitors list',
  VIS,
  idxOf(V, (v) => v.host === 'Anand Kumar'),
  'list',
);
rows(
  'Maintenance visitors from Dell',
  VIS,
  idxOf(V, (v) => v.purpose === 'Maintenance' && v.company === 'Dell'),
  'list',
);
rows(
  'how many visitors visited in 2025',
  VIS,
  idxOf(V, (v) => v.date.startsWith('2025')),
  'count',
);
rows(
  'Router products list',
  INV,
  idxOf(I, (x) => x.name === 'Router'),
  'list',
);
rows(
  'Networking category items with quantity above 100',
  INV,
  idxOf(I, (x) => x.cat === 'Networking' && x.qty > 100),
  'list',
);
rows(
  'Cisco supplier la Delhi warehouse products',
  INV,
  idxOf(I, (x) => x.supplier === 'Cisco' && x.wh === 'Delhi'),
  'list',
);

// ───────────────────────── third set: written blind, scored three ways ─────────────────────────
// correct  = the rules answered and the answer matches the independent oracle
// deferred = the rules were unsure → the question goes to the model (fine, but slower)
// wrong    = the rules were SURE and the answer is wrong  ← must stay at zero
const blind = [];
function soft(question, verify) {
  test(`blind: ${question}`, () => {
    const out = ask(question);
    const { compiled, res } = out;
    if (!(compiled.kind === 'analytic' && compiled.confident)) {
      blind.push({ question, outcome: 'deferred' });
      return;
    }
    let ok = false;
    try {
      ok = !!verify(out, res);
    } catch {
      ok = false;
    }
    blind.push({
      question,
      outcome: ok ? 'correct' : 'wrong',
      plan: JSON.stringify(compiled.plan),
    });
    assert.ok(
      ok,
      `CONFIDENT BUT WRONG: ${JSON.stringify(compiled.plan)} → ${res?.matched} rows, value=${res?.value}`,
    );
  });
}
const sameRows =
  (expected, table = EMP) =>
  (out, res) =>
    out.tableIndex === table && sameSet(res.indexes, expected);
const sameValue =
  (expected, table = EMP) =>
  (out, res) =>
    out.tableIndex === table && res.value === expected;
const sameGroups =
  (expected, table = EMP) =>
  (out, res) =>
    out.tableIndex === table &&
    JSON.stringify(Object.entries(groupMap(res)).sort()) ===
      JSON.stringify(Object.entries(expected).sort());
const firstKey =
  (keys, table = EMP) =>
  (out, res) =>
    out.tableIndex === table &&
    keys.includes(Array.isArray(res.groups[0]) ? res.groups[0][0] : res.groups[0].key);

soft('Chennai la evlo employees irukanga', sameRows(idxOf(E, inCity('Chennai'))));
soft('TCS employees evlo per', sameRows(idxOf(E, (e) => e.company === 'TCS')));
soft('Infosys la work panravanga count', sameRows(idxOf(E, (e) => e.company === 'Infosys')));
soft('total employees count', sameRows(idxOf(E, () => true)));
soft('Madurai employees list kudu', sameRows(idxOf(E, inCity('Madurai'))));
soft('salary 1 lakh ku mela irukkuravanga list', sameRows(idxOf(E, (e) => e.salary > 100000)));
soft('2022 la join aanavanga evlo per', sameRows(idxOf(E, (e) => e.joined.startsWith('2022'))));
soft('Active ah irukkura employees count', sameRows(idxOf(E, (e) => e.status === 'Active')));
soft('resigned aana employees list', sameRows(idxOf(E, (e) => e.status === 'Resigned')));
soft(
  'Engineering department la average salary',
  sameValue(
    round2(
      sum(E.filter((e) => e.dept === 'Engineering').map((e) => e.salary)) /
        E.filter((e) => e.dept === 'Engineering').length,
    ),
  ),
);
soft('maximum salary evlo', sameValue(Math.max(...E.map((e) => e.salary))));
soft('yaar adhigama salary vaangurathu', sameValue(Math.max(...E.map((e) => e.salary))));
soft(
  'Salem and Trichy employees',
  sameRows(idxOf(E, (e) => e.city === 'Salem' || e.city === 'Trichy')),
);
soft(
  'Wipro employees who joined after 2022',
  sameRows(idxOf(E, (e) => e.company === 'Wipro' && e.joined > '2022-12-31')),
);
soft(
  'employees who joined in 2019 and earn above 120000',
  sameRows(idxOf(E, (e) => e.joined.startsWith('2019') && e.salary > 120000)),
);
soft(
  'HR employees in Chennai with salary below 90000',
  sameRows(idxOf(E, (e) => e.dept === 'HR' && e.city === 'Chennai' && e.salary < 90000)),
);
soft(
  'sales team la Active people count',
  sameRows(idxOf(E, (e) => e.dept === 'Sales' && e.status === 'Active')),
);
soft(
  'how many people joined in the year 2020',
  sameRows(idxOf(E, (e) => e.joined.startsWith('2020'))),
);
soft('count employees whose salary is over 175000', sameRows(idxOf(E, (e) => e.salary > 175000)));
soft('employees earning exactly 100000', sameRows(idxOf(E, (e) => e.salary === 100000)));
soft('employees with salary 100000 or more', sameRows(idxOf(E, (e) => e.salary >= 100000)));
soft(
  'list Zoho employees sorted by salary',
  (out, res) =>
    out.tableIndex === EMP &&
    sameSet(
      res.indexes,
      idxOf(E, (e) => e.company === 'Zoho'),
    ),
);
soft(
  'city wise count of Wipro employees',
  sameGroups(
    tally(
      E.filter((e) => e.company === 'Wipro'),
      (e) => e.city,
    ),
  ),
);
soft(
  'department wise average salary in Chennai',
  sameGroups(
    groupedStat(
      E.filter(inCity('Chennai')),
      (e) => e.dept,
      (e) => e.salary,
      'avg',
    ),
  ),
);
soft(
  'company wise highest salary',
  sameGroups(
    groupedStat(
      E,
      (e) => e.company,
      (e) => e.salary,
      'max',
    ),
  ),
);
soft(
  'status wise count in Madurai',
  sameGroups(tally(E.filter(inCity('Madurai')), (e) => e.status)),
);
soft('yearly joining count', sameGroups(tally(E, (e) => e.joined.slice(0, 4))));
soft(
  'month wise visitors count',
  sameGroups(
    tally(V, (v) => v.date.slice(0, 7)),
    VIS,
  ),
);
soft('which city has the highest salary', sameValue(Math.max(...E.map((e) => e.salary))));
soft(
  'which department has the maximum number of employees',
  firstKey(maxKeys(tally(E, (e) => e.dept))),
);
soft('city with minimum employees', firstKey(minKeys(tally(E, (e) => e.city))));
soft(
  'which supplier has the highest total quantity',
  firstKey(
    maxKeys(
      groupedStat(
        I,
        (x) => x.supplier,
        (x) => x.qty,
        'sum',
      ),
    ),
    INV,
  ),
);
soft(
  'how many suppliers',
  (out, res) => out.tableIndex === INV && res.value === new Set(I.map((x) => x.supplier)).size,
);
soft(
  'Laptop stock quantity',
  sameValue(sum(I.filter((x) => x.name === 'Laptop').map((x) => x.qty)), INV),
);
soft(
  'how many Laptop products are there',
  sameRows(
    idxOf(I, (x) => x.name === 'Laptop'),
    INV,
  ),
);
soft(
  'items restocked in 2026',
  sameRows(
    idxOf(I, (x) => x.restocked.startsWith('2026')),
    INV,
  ),
);
soft(
  'Mumbai warehouse total quantity',
  sameValue(sum(I.filter((x) => x.wh === 'Mumbai').map((x) => x.qty)), INV),
);
soft('most expensive product', sameValue(Math.max(...I.map((x) => x.price)), INV));
soft(
  'cheapest Mouse price',
  sameValue(Math.min(...I.filter((x) => x.name === 'Mouse').map((x) => x.price)), INV),
);
soft(
  'HP supplier Laptop count',
  sameRows(
    idxOf(I, (x) => x.supplier === 'HP' && x.name === 'Laptop'),
    INV,
  ),
);
soft(
  'Reliance visitors list',
  sameRows(
    idxOf(V, (v) => v.company === 'Reliance'),
    VIS,
  ),
);
soft(
  'Esha Menon host panna visitors count',
  sameRows(
    idxOf(V, (v) => v.host === 'Esha Menon'),
    VIS,
  ),
);
soft(
  'Delivery purpose visitors in 2025',
  sameRows(
    idxOf(V, (v) => v.purpose === 'Delivery' && v.date.startsWith('2025')),
    VIS,
  ),
);
soft(
  'visitors per host',
  sameGroups(
    tally(V, (v) => v.host),
    VIS,
  ),
);
soft(
  'visit purpose wise count',
  sameGroups(
    tally(V, (v) => v.purpose),
    VIS,
  ),
);
// Things the sheets cannot answer: the rules must NOT invent an answer.
soft('average age of employees', () => false);
soft('why did Rajesh resign', () => false);
soft('predict next year attrition', () => false);
soft('which employees are underpaid', () => false);
soft('compare TCS and Infosys salary trend', () => false);
soft('how many employees are female', () => false);
soft('total revenue', () => false);

after(() => {
  const count = (o) => blind.filter((b) => b.outcome === o).length;
  console.log(
    `\nBLIND SET (${blind.length}): correct ${count('correct')} · deferred to model ${count('deferred')} · WRONG ${count('wrong')}`,
  );
  for (const b of blind.filter((x) => x.outcome === 'wrong'))
    console.log(`  ✗ WRONG: ${b.question}  ${b.plan}`);
  for (const b of blind.filter((x) => x.outcome === 'deferred'))
    console.log(`  … deferred: ${b.question}`);
});

// ───────────────────────── fourth set: fresh phrasing, ONE file at a time (the common demo case) ─────────────────────────
const salesRegions = ['North', 'South', 'East', 'West'];
const salesProducts = ['Phone', 'Laptop', 'TV', 'Fridge', 'Tablet'];
const salespeople = ['Anitha Rao', 'Bala Murugan', 'Chitra Lakshmi', 'Dev Anand', 'Eswari Devi'];
const fmtINR = (n) => `₹${n.toLocaleString('en-IN')}`;
const sales = {
  columns: ['Order ID', 'Order Date', 'Region', 'Product', 'Salesperson', 'Units', 'Revenue'],
  rows: Array.from({ length: 240 }, (_, i) => {
    const year = 2022 + Math.floor(rnd() * 3);
    const month = 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 28);
    const units = 1 + Math.floor(rnd() * 20);
    return [
      `ORD-${5000 + i}`,
      `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
      pick(salesRegions),
      pick(salesProducts),
      pick(salespeople),
      String(units),
      fmtINR(units * (3000 + Math.floor(rnd() * 40) * 1000)),
    ];
  }),
};
const S = sales.rows.map((r, idx) => {
  const [d, m, y] = r[1].split('/');
  return {
    idx,
    id: r[0],
    iso: `${y}-${m}-${d}`,
    region: r[2],
    product: r[3],
    rep: r[4],
    units: Number(r[5]),
    revenue: Number(r[6].replace(/[₹,]/g, '')),
  };
});
const salesOnly = [
  {
    table: {
      id: 'sales',
      filename: 'Sales-Report.xlsx',
      sheet: 'Orders',
      columns: sales.columns,
      rowCount: sales.rows.length,
    },
    rows: sales.rows,
  },
];
const empOnly = [tables[EMP]];
const fresh = [];
function freshQ(question, candidates, verify) {
  test(`fresh: ${question}`, () => {
    const out = ask(question, candidates);
    const { compiled, res } = out;
    if (!(compiled.kind === 'analytic' && compiled.confident)) {
      fresh.push({ question, outcome: 'deferred' });
      return;
    }
    let ok = false;
    try {
      ok = !!verify(res, compiled);
    } catch {
      ok = false;
    }
    fresh.push({
      question,
      outcome: ok ? 'correct' : 'wrong',
      plan: JSON.stringify(compiled.plan),
    });
    assert.ok(
      ok,
      `CONFIDENT BUT WRONG: ${JSON.stringify(compiled.plan)} → ${res?.matched} rows, value=${res?.value}`,
    );
  });
}
const rowsAre = (list, fn) => (res) => sameSet(res.indexes, idxOf(list, fn));
const valueIs = (v) => (res) => res.value === v;
const groupsAre = (m) => (res) =>
  JSON.stringify(Object.entries(groupMap(res)).sort()) === JSON.stringify(Object.entries(m).sort());
const topIs = (keys) => (res) =>
  keys.includes(Array.isArray(res.groups[0]) ? res.groups[0][0] : res.groups[0].key);
const SALES = salesOnly;
freshQ('total revenue', SALES, valueIs(sum(S.map((x) => x.revenue))));
freshQ(
  'how many orders in South region',
  SALES,
  rowsAre(S, (x) => x.region === 'South'),
);
freshQ(
  'region wise revenue',
  SALES,
  groupsAre(
    groupedStat(
      S,
      (x) => x.region,
      (x) => x.revenue,
      'sum',
    ),
  ),
);
freshQ(
  'average revenue per order',
  SALES,
  valueIs(round2(sum(S.map((x) => x.revenue)) / S.length)),
);
freshQ(
  'Phone sales total units',
  SALES,
  valueIs(sum(S.filter((x) => x.product === 'Phone').map((x) => x.units))),
);
freshQ(
  'orders placed in 2024',
  SALES,
  rowsAre(S, (x) => x.iso.startsWith('2024')),
);
freshQ(
  'revenue of Laptop in West',
  SALES,
  valueIs(
    sum(S.filter((x) => x.product === 'Laptop' && x.region === 'West').map((x) => x.revenue)),
  ),
);
freshQ(
  'which region has the highest revenue',
  SALES,
  topIs(
    maxKeys(
      groupedStat(
        S,
        (x) => x.region,
        (x) => x.revenue,
        'sum',
      ),
    ),
  ),
);
freshQ(
  'top 5 orders by revenue',
  SALES,
  (res) =>
    JSON.stringify(res.indexes.slice(0, 5).map((i) => S[i].revenue)) ===
    JSON.stringify(
      [...S]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map((x) => x.revenue),
    ),
);
freshQ(
  'orders above 50000',
  SALES,
  rowsAre(S, (x) => x.revenue > 50000),
);
freshQ(
  'Anitha Rao sales count',
  SALES,
  rowsAre(S, (x) => x.rep === 'Anitha Rao'),
);
freshQ(
  'salesperson wise total revenue',
  SALES,
  groupsAre(
    groupedStat(
      S,
      (x) => x.rep,
      (x) => x.revenue,
      'sum',
    ),
  ),
);
freshQ(
  'product wise units',
  SALES,
  groupsAre(
    groupedStat(
      S,
      (x) => x.product,
      (x) => x.units,
      'sum',
    ),
  ),
);
freshQ(
  'how many orders in March 2024',
  SALES,
  rowsAre(S, (x) => x.iso.startsWith('2024-03')),
);
freshQ(
  'orders after 2023',
  SALES,
  rowsAre(S, (x) => x.iso > '2023-12-31'),
);
freshQ(
  'East ku evlo orders',
  SALES,
  rowsAre(S, (x) => x.region === 'East'),
);
freshQ('highest revenue order', SALES, valueIs(Math.max(...S.map((x) => x.revenue))));
freshQ('lowest units sold', SALES, valueIs(Math.min(...S.map((x) => x.units))));
freshQ(
  'list TV orders from North',
  SALES,
  rowsAre(S, (x) => x.product === 'TV' && x.region === 'North'),
);
freshQ(
  'TV illama ellam orders count',
  SALES,
  rowsAre(S, (x) => x.product !== 'TV'),
);
freshQ(
  'orders on 05/03/2023',
  SALES,
  rowsAre(S, (x) => x.iso === '2023-03-05'),
);
freshQ(
  'units sold by Dev Anand in 2023',
  SALES,
  valueIs(
    sum(S.filter((x) => x.rep === 'Dev Anand' && x.iso.startsWith('2023')).map((x) => x.units)),
  ),
);
freshQ(
  'Fridge or Tablet orders',
  SALES,
  rowsAre(S, (x) => x.product === 'Fridge' || x.product === 'Tablet'),
);
freshQ(
  'average units per product',
  SALES,
  groupsAre(
    groupedStat(
      S,
      (x) => x.product,
      (x) => x.units,
      'avg',
    ),
  ),
);
freshQ('year wise orders', SALES, groupsAre(tally(S, (x) => x.iso.slice(0, 4))));

freshQ(
  'Chennai Infosys Active count',
  empOnly,
  rowsAre(E, (e) => e.city === 'Chennai' && e.company === 'Infosys' && e.status === 'Active'),
);
freshQ(
  'give employees names in HR from Pune',
  empOnly,
  rowsAre(E, (e) => e.dept === 'HR' && e.city === 'Pune'),
);
freshQ(
  'how many are there in Support',
  empOnly,
  rowsAre(E, (e) => e.dept === 'Support'),
);
freshQ(
  'highest paid person in Engineering',
  empOnly,
  valueIs(Math.max(...E.filter((e) => e.dept === 'Engineering').map((e) => e.salary))),
);
freshQ(
  'avg salary Trichy',
  empOnly,
  valueIs(
    round2(
      sum(E.filter(inCity('Trichy')).map((e) => e.salary)) / E.filter(inCity('Trichy')).length,
    ),
  ),
);
freshQ(
  'joined 2017 la evlo',
  empOnly,
  rowsAre(E, (e) => e.joined.startsWith('2017')),
);
freshQ(
  'employees whose status is On Leave',
  empOnly,
  rowsAre(E, (e) => e.status === 'On Leave'),
);
freshQ(
  'city wise Active count',
  empOnly,
  groupsAre(
    tally(
      E.filter((e) => e.status === 'Active'),
      (e) => e.city,
    ),
  ),
);
freshQ(
  'company wise resigned count',
  empOnly,
  groupsAre(
    tally(
      E.filter((e) => e.status === 'Resigned'),
      (e) => e.company,
    ),
  ),
);
freshQ(
  'employees joined in the last 5 years',
  empOnly,
  rowsAre(E, (e) => e.joined >= '2021-10-08'),
);
freshQ(
  'salary more than 2 lakh',
  empOnly,
  rowsAre(E, (e) => e.salary > 200000),
);
freshQ(
  'show me everyone in Zoho',
  empOnly,
  rowsAre(E, (e) => e.company === 'Zoho'),
);
freshQ(
  'number of people in Finance dept',
  empOnly,
  rowsAre(E, (e) => e.dept === 'Finance'),
);
freshQ(
  'who joined first',
  empOnly,
  (res) =>
    E[res.indexes[0]].joined === [...E].sort((a, b) => a.joined.localeCompare(b.joined))[0].joined,
);
freshQ('how many departments', empOnly, valueIs(new Set(E.map((e) => e.dept)).size));
freshQ(
  'Hyderabad and Bengaluru la irukkura Zoho employees',
  empOnly,
  rowsAre(E, (e) => e.company === 'Zoho' && (e.city === 'Hyderabad' || e.city === 'Bengaluru')),
);
freshQ('Salary details of Priya Nair', empOnly, () => false);
freshQ('total payroll', empOnly, () => false);
freshQ('how many employees will retire this year', empOnly, () => false);

after(() => {
  const count = (o) => fresh.filter((b) => b.outcome === o).length;
  console.log(
    `\nFRESH SET (${fresh.length}): correct ${count('correct')} · deferred to model ${count('deferred')} · WRONG ${count('wrong')}`,
  );
  for (const b of fresh.filter((x) => x.outcome === 'wrong'))
    console.log(`  ✗ WRONG: ${b.question}  ${b.plan}`);
  for (const b of fresh.filter((x) => x.outcome === 'deferred'))
    console.log(`  … deferred: ${b.question}`);
});

// ───────────────────────── not analytic ─────────────────────────
notAnalytic('Rajesh Subramanian details');
notAnalytic('EMP1010 details enna');
notAnalytic('Kavya Shankar enga irukaru');
notAnalytic('what is the leave policy');
notAnalytic('summarize this document');
notAnalytic('explain the onboarding process');

// ───────────────────────── repairing model plans ─────────────────────────
const empProfile = profileTable(tables[EMP].table, tables[EMP].rows);
const outcome = (plan) => executePlan(plan, tables[EMP].table, tables[EMP].rows);
function repaired(question, rawPlan) {
  const compiled = compileQuestion(question, tables, { now: NOW });
  return repairPlan(rawPlan, empProfile, question, {
    compiled: compiled.tableIndex === EMP ? compiled : null,
  });
}
const chennai = idxOf(E, inCity('Chennai'));
const repairCases = [
  [
    'misspelt value',
    'how many employees in Chennai',
    { filters: [{ column: 'City', op: 'contains', value: 'Chenai' }], operation: 'count' },
    chennai,
  ],
  [
    'wrong column name',
    'employees in Chennai',
    { filters: [{ column: 'Location', op: 'equals', value: 'Chennai' }], operation: 'list' },
    chennai,
  ],
  [
    'value in the wrong column',
    'how many in Chennai',
    { filters: [{ column: 'Company', op: 'equals', value: 'Chennai' }], operation: 'count' },
    chennai,
  ],
  [
    'hallucinated extra filter',
    'how many employees in Chennai',
    {
      filters: [
        { column: 'City', op: 'equals', value: 'Chennai' },
        { column: 'Status', op: 'equals', value: 'Atlantis' },
      ],
      operation: 'count',
    },
    chennai,
  ],
  [
    'forgot a filter',
    'how many Active employees in Chennai',
    { filters: [{ column: 'City', op: 'equals', value: 'Chennai' }], operation: 'count' },
    idxOf(E, (e) => e.city === 'Chennai' && e.status === 'Active'),
  ],
  [
    'case and spacing',
    'TCS employees',
    { filters: [{ column: 'company', op: '=', value: ' tcs ' }], operation: 'list' },
    idxOf(E, (e) => e.company === 'TCS'),
  ],
  [
    'array for a single value',
    'Madurai employees',
    { filters: [{ column: 'City', op: 'in', value: ['Madurai'] }], operation: 'list' },
    idxOf(E, inCity('Madurai')),
  ],
  [
    'year as text',
    'joined in 2023',
    { filters: [{ column: 'Joining Date', op: 'equals', value: '2023' }], operation: 'list' },
    null,
  ],
];
for (const [label, question, rawPlan, expected] of repairCases) {
  test(`repair: ${label}`, () => {
    const { plan, changes } = repaired(question, rawPlan);
    const res = outcome(plan);
    if (expected)
      assert.ok(
        sameSet(res.indexes, expected),
        `got ${res.matched} rows, expected ${expected.length}; plan=${JSON.stringify(plan)} changes=${changes}`,
      );
    else assert.ok(plan.filters.length >= 0);
  });
}
test('repair: operation words win over a lazy list plan', () => {
  const { plan } = repaired('average salary in TCS', {
    filters: [{ column: 'Company', op: 'equals', value: 'TCS' }],
    operation: 'list',
  });
  assert.equal(plan.operation, 'avg');
  assert.equal(plan.column, 'Salary');
});
test('repair: sum without a column picks the only measure', () => {
  const { plan } = repaired('total salary', { filters: [], operation: 'sum' });
  assert.equal(plan.column, 'Salary');
});
test('repair: operation aliases and group column typos', () => {
  const { plan } = repaired('average salary per department', {
    filters: [],
    operation: 'average',
    column: 'salary',
    groupBy: 'dept',
  });
  assert.equal(plan.operation, 'avg');
  assert.equal(plan.groupBy, 'Department');
  const res = outcome(plan);
  assert.deepEqual(
    groupMap(res),
    groupedStat(
      E,
      (e) => e.dept,
      (e) => e.salary,
      'avg',
    ),
  );
});

// ───────────────────────── summary ─────────────────────────
after(() => {
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\nQUESTION ACCURACY: ${passed}/${results.length} (${Math.round((100 * passed) / results.length)}%)`,
  );
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.question}`);
});
