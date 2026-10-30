import path from 'node:path';
import { detectFileTask } from './intent.js';
import { runPlan, profileTable, TableOpError } from './tableOps.js';
import { planTableOperations, describeOperation } from './planner.js';
import { toCsv, toXlsx, toMarkdownTable, MIME } from './writers.js';
import { joinChunks, extractEntities } from './extract.js';
import { summarizeDocument } from './summarize.js';
import { outputLink } from './outputs.js';
import { assertOrganizableRoot, createPlan, describePlan, OrganizeError } from './organize.js';
import { markdownToBlocks, toDocx, toHtml, htmlToPdf, tableReportBlocks } from './documents.js';

export { detectFileTask };

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PDF = 'application/pdf';
const SHEET_EXT = new Set(['.xlsx', '.csv']);
const baseName = (name) => path.basename(String(name || 'file'), path.extname(String(name || '')));
const plural = (n, word) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`;

/**
 * Runs one file-agent task and streams the answer.
 * @param {object} o
 * @param {object} o.task result of detectFileTask
 * @param {string} o.message user message
 * @param {string} o.userId
 * @param {string[]} o.documentIds attached text documents
 * @param {(text: string) => void} o.emit stream text to the chat
 * @param {(text: string) => void} o.status progress line in the UI
 * @param {object} o.deps { loadDocuments, chat, completeJSON, outputs, plans, workspaceRoot, validateRoot, protectedRoots, model, htmlToPdf? }
 * @returns {Promise<string>} the full message content (for history)
 */
export async function runFileAgent({ task, message, userId, documentIds, workspaceId, emit, status, signal, deps }) {
  let content = '';
  const say = (text) => {
    content += text;
    emit(text);
  };
  const save = async (name, data, mime) => deps.outputs.save(userId, name, data, mime);
  const pdfFromHtml = deps.htmlToPdf || htmlToPdf;

  /** Save a block document in the requested formats; returns markdown link lines. */
  async function saveDocument({ title, blocks, fileBase, formats }) {
    const links = [];
    for (const format of formats) {
      if (format === 'docx') {
        links.push(outputLink(await save(`${fileBase}.docx`, toDocx({ title, blocks }), MIME_DOCX)));
      } else if (format === 'pdf') {
        status?.('Creating the PDF');
        const htmlText = toHtml({ title, blocks });
        const pdf = await pdfFromHtml(htmlText);
        if (pdf) links.push(outputLink(await save(`${fileBase}.pdf`, pdf, MIME_PDF)));
        else {
          links.push(outputLink(await save(`${fileBase}.html`, htmlText, 'text/html; charset=utf-8')));
          links.push(
            '_PDF needs Microsoft Edge or Google Chrome on this PC. Open the HTML file and use Print → Save as PDF._',
          );
        }
      } else if (format === 'md') {
        links.push(outputLink(await save(`${fileBase}.md`, blocksToMarkdown(title, blocks), MIME.md)));
      } else if (format === 'txt') {
        links.push(outputLink(await save(`${fileBase}.txt`, blocksToMarkdown(title, blocks), MIME.txt)));
      }
    }
    return links;
  }

  try {
    // ---------- organize / rename a folder ----------
    if (task.kind === 'organize') {
      let root = null;
      if (task.path) root = (await deps.validateRoot(task.path)).root;
      else if (workspaceId) root = await deps.workspaceRoot(userId, workspaceId);
      if (!root) {
        say(
          'Which folder should I organize? Write its full path, for example **organize D:\\Downloads by type**, or select a connected workspace folder first. Nothing has been changed.',
        );
        return content;
      }
      root = assertOrganizableRoot(root, { protectedRoots: deps.protectedRoots || [] });
      status?.('Scanning the folder');
      const plan = await createPlan(deps.plans, { userId, root, mode: task.mode, recursive: task.recursive });
      say(describePlan(plan));
      return content;
    }

    status?.('Reading the attached files');
    const docs = await deps.loadDocuments(userId, documentIds);
    if (!docs.length) {
      say('I could not read the attached files. Upload them again and retry.');
      return content;
    }
    const allTables = docs.flatMap((d) => d.tables);

    // ---------- automatic: files uploaded without instructions ----------
    if (task.kind === 'auto' || task.kind === 'summarize' || (task.kind === 'report' && !allTables.length)) {
      const formats =
        task.kind === 'report' ? [task.format] : task.format ? [task.format] : ['md'];
      for (const [index, doc] of docs.entries()) {
        if (docs.length > 1) say(`${index ? '\n\n' : ''}## ${doc.name}\n\n`);
        if (doc.tables.length && SHEET_EXT.has(doc.ext)) {
          const profileText = profileMarkdown(doc);
          say(profileText);
          if (task.kind === 'report' || task.format) {
            const links = await saveDocument({
              title: `${baseName(doc.name)} — data report`,
              blocks: [...markdownToBlocks(profileText), ...tableReportBlocks(doc.tables)],
              fileBase: `${baseName(doc.name)}-report`,
              formats,
            });
            say(`\n\n${links.join('\n\n')}`);
          }
          continue;
        }
        if (!doc.text.trim()) {
          say('_No readable text in this file._');
          continue;
        }
        const summary = await summarizeDocument({
          name: doc.name,
          text: doc.text,
          request: task.kind === 'auto' ? '' : message,
          chat: deps.chat,
          emit: say,
          status,
          signal,
        });
        const links = await saveDocument({
          title: `Summary — ${baseName(doc.name)}`,
          blocks: markdownToBlocks(summary),
          fileBase: `${baseName(doc.name)}-summary`,
          formats,
        });
        say(`\n\n${links.join('\n\n')}`);
      }
      if (task.kind === 'auto') say(`\n\n${suggestions(docs)}`);
      return content;
    }

    // ---------- report from table data ----------
    if (task.kind === 'report') {
      const blocks = [];
      for (const doc of docs.filter((d) => d.tables.length)) {
        blocks.push(...markdownToBlocks(profileMarkdown(doc, 2)));
      }
      blocks.push({ type: 'heading', level: 1, text: 'Data' });
      blocks.push(...tableReportBlocks(allTables));
      const fileBase = `${baseName(docs[0].name)}-report`;
      const formats = task.format === 'xlsx' || task.format === 'csv' ? [] : [task.format];
      const links = await saveDocument({ title: `${baseName(docs[0].name)} — report`, blocks, fileBase, formats });
      if (['xlsx', 'csv'].includes(task.format) || !links.length)
        links.push(outputLink(await save(`${fileBase}.xlsx`, toXlsx(allTables), MIME.xlsx)));
      say(`Report created from ${plural(allTables.length, 'table')} (${plural(allTables.reduce((n, t) => n + t.rows.length, 0), 'row')}).\n\n${links.join('\n\n')}`);
      return content;
    }

    // ---------- table operations ----------
    if (task.kind === 'table') {
      if (!allTables.length) {
        say('These files have no tables. Attach an Excel or CSV file for table operations.');
        return content;
      }
      status?.('Planning the table changes');
      const { plan, source } = await planTableOperations({
        request: message,
        tables: allTables,
        completeJSON: deps.completeJSON,
        model: deps.model,
        signal,
      });
      status?.('Applying the changes');
      const result = runPlan(allTables, plan);
      const steps = [
        ...(plan.merge ? [`Merged ${plural(allTables.length, 'table')} into one`] : []),
        ...plan.operations.map(describeOperation),
      ];
      const before = allTables.reduce((n, t) => n + t.rows.length, 0);
      const after = result.tables.reduce((n, t) => n + t.rows.length, 0);
      const fileBase = plan.outputName || `${baseName(docs[0].name)}-${plan.merge ? 'merged' : 'result'}`;
      const links = [outputLink(await save(`${fileBase}.xlsx`, toXlsx(result.tables), MIME.xlsx))];
      if (task.format === 'csv' && result.tables.length === 1)
        links.push(outputLink(await save(`${fileBase}.csv`, toCsv(result.tables[0]), MIME.csv)));
      if (['pdf', 'docx'].includes(task.format))
        links.push(
          ...(await saveDocument({
            title: fileBase,
            blocks: [{ type: 'bullets', items: steps }, ...tableReportBlocks(result.tables)],
            fileBase,
            formats: [task.format],
          })),
        );
      say(
        `**Done.** ${steps.length ? '' : 'No changes were needed.'}\n\n${steps.map((s) => `- ${s}`).join('\n')}\n\n` +
          `Rows: ${before.toLocaleString('en-IN')} → **${after.toLocaleString('en-IN')}**` +
          (source === 'fallback' ? ' _(planned without the model)_' : '') +
          `\n\n${result.tables
            .map((t) => `${result.tables.length > 1 ? `**${t.name}**\n\n` : ''}${toMarkdownTable(t, 15)}${t.rows.length > 15 ? `\n\n_Showing 15 of ${plural(t.rows.length, 'row')}._` : ''}`)
            .join('\n\n')}\n\n${links.join('\n\n')}`,
      );
      return content;
    }

    // ---------- convert ----------
    if (task.kind === 'convert') {
      const links = [];
      const f = task.format;
      if (f === 'xlsx' || f === 'csv') {
        if (!allTables.length) {
          say('These files have no tables to put in a spreadsheet. Ask for **text** or **markdown** instead, or use "extract emails / dates / amounts".');
          return content;
        }
        if (f === 'xlsx') links.push(outputLink(await save(`${baseName(docs[0].name)}.xlsx`, toXlsx(allTables), MIME.xlsx)));
        else for (const t of allTables.slice(0, 20)) links.push(outputLink(await save(`${baseName(t.source || t.name)}${allTables.length > 1 ? `-${t.name}` : ''}.csv`, toCsv(t), MIME.csv)));
      } else if (f === 'json') {
        const data = docs.map((d) => ({
          file: d.name,
          ...(d.tables.length
            ? { tables: d.tables.map((t) => ({ name: t.name, rows: t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null]))) })) }
            : { text: d.text }),
        }));
        links.push(outputLink(await save(`${baseName(docs[0].name)}.json`, JSON.stringify(data.length === 1 ? data[0] : data, null, 2), MIME.json)));
      } else {
        for (const d of docs) {
          const blocks = d.tables.length && SHEET_EXT.has(d.ext) ? tableReportBlocks(d.tables) : textBlocks(d.text);
          if (f === 'txt' || f === 'md') {
            const body = f === 'txt' ? d.text : d.tables.length && SHEET_EXT.has(d.ext) ? d.tables.map((t) => toMarkdownTable(t, 1e9)).join('\n\n') : d.text;
            links.push(outputLink(await save(`${baseName(d.name)}.${f}`, body, MIME[f])));
          } else {
            links.push(...(await saveDocument({ title: baseName(d.name), blocks, fileBase: baseName(d.name), formats: [f] })));
          }
        }
      }
      say(`Converted ${plural(docs.length, 'file')} to **${f.toUpperCase()}**.\n\n${links.join('\n\n')}`);
      return content;
    }

    // ---------- extract ----------
    if (task.kind === 'extract') {
      const parts = [];
      const links = [];
      const targets = task.targets;
      if (targets.includes('tables')) {
        if (allTables.length) {
          links.push(outputLink(await save(`${baseName(docs[0].name)}-tables.xlsx`, toXlsx(allTables), MIME.xlsx)));
          parts.push(`Found ${plural(allTables.length, 'table')}.`);
        } else parts.push('No tables were found in these files.');
      }
      if (targets.includes('text')) {
        for (const d of docs) links.push(outputLink(await save(`${baseName(d.name)}.txt`, d.text, MIME.txt)));
        parts.push(`Extracted the text of ${plural(docs.length, 'file')}.`);
      }
      const entityTargets = targets.filter((t) => !['tables', 'text'].includes(t));
      if (entityTargets.length) {
        const sourceDocs = docs.map((d) => ({
          name: d.name,
          text: d.text + (d.tables.length ? `\n${d.tables.flatMap((t) => t.rows.map((r) => r.join(' '))).join('\n')}` : ''),
        }));
        const table = extractEntities(sourceDocs, entityTargets);
        if (table.rows.length) {
          const counts = new Map();
          table.rows.forEach((r) => counts.set(r[0], (counts.get(r[0]) || 0) + 1));
          parts.push(`Found ${[...counts].map(([k, v]) => `${v} ${k.toLowerCase()}${v === 1 ? '' : 's'}`).join(', ')}.`);
          parts.push(toMarkdownTable({ columns: table.columns.slice(0, 3), rows: table.rows.map((r) => r.slice(0, 3)) }, 15));
          if (table.rows.length > 15) parts.push(`_Showing 15 of ${table.rows.length}._`);
          links.push(outputLink(await save(`${baseName(docs[0].name)}-extracted.xlsx`, toXlsx([table]), MIME.xlsx)));
          if (task.format === 'csv') links.push(outputLink(await save(`${baseName(docs[0].name)}-extracted.csv`, toCsv(table), MIME.csv)));
          if (['pdf', 'docx'].includes(task.format))
            links.push(...(await saveDocument({ title: 'Extracted data', blocks: tableReportBlocks([table]), fileBase: `${baseName(docs[0].name)}-extracted`, formats: [task.format] })));
        } else parts.push(`No ${entityTargets.join(', ')} were found.`);
      }
      say(`${parts.join('\n\n')}${links.length ? `\n\n${links.join('\n\n')}` : ''}`);
      return content;
    }

    say('I could not tell which file task you want. Try "summarize", "convert to Excel/PDF/Word", "extract emails", "remove duplicates" or "organize D:\\Downloads by type".');
    return content;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TableOpError || error instanceof OrganizeError || error.status) {
      say(`${content ? '\n\n' : ''}⚠️ ${error.message}`);
      return content;
    }
    throw error;
  }
}

function blocksToMarkdown(title, blocks) {
  const out = title ? [`# ${title}`] : [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push(`${'#'.repeat((b.level || 1) + 1)} ${b.text}`);
    else if (b.type === 'paragraph') out.push(b.italic ? `_${b.text}_` : b.text);
    else if (b.type === 'bullets') out.push(b.items.map((i) => `- ${i}`).join('\n'));
    else if (b.type === 'table') out.push(toMarkdownTable(b, 1e9));
  }
  return out.join('\n\n') + '\n';
}

function textBlocks(text) {
  const blocks = [];
  for (const para of String(text || '').split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    const page = t.match(/^--- Page (\d+) ---$/);
    if (page) blocks.push({ type: 'heading', level: 3, text: `Page ${page[1]}` });
    else blocks.push({ type: 'paragraph', text: t.replace(/\n/g, ' ') });
  }
  return blocks;
}

function profileMarkdown(doc, headingLevel = 0) {
  const lines = [];
  for (const table of doc.tables) {
    const p = profileTable(table);
    const title = doc.tables.length > 1 || headingLevel ? `${'#'.repeat(headingLevel || 3)} ${table.name}\n\n` : '';
    lines.push(
      `${title}**${plural(p.rows, 'row')}, ${plural(p.columns.length, 'column')}.** ` +
        `${p.duplicates ? `${plural(p.duplicates, 'duplicate row')}. ` : 'No duplicate rows. '}` +
        `${p.emptyRows ? `${plural(p.emptyRows, 'empty row')}.` : ''}`,
    );
    lines.push(
      toMarkdownTable(
        {
          columns: ['Column', 'Type', 'Empty', 'Distinct', 'Sum', 'Min', 'Max', 'Average'],
          rows: p.columns.map((c) => [
            c.name,
            c.numeric ? 'Number' : 'Text',
            c.empty,
            c.distinct,
            c.sum ?? '',
            c.min ?? '',
            c.max ?? '',
            c.avg ?? '',
          ]),
        },
        60,
      ),
    );
  }
  return lines.join('\n\n');
}

function suggestions(docs) {
  const hasTables = docs.some((d) => d.tables.length);
  const tips = hasTables
    ? ['"remove duplicates"', '"clean this data"', '"total Amount by Region and export to Excel"', '"make a PDF report"', '"merge these files"']
    : ['"make a Word document of the summary"', '"convert to PDF"', '"extract emails and phone numbers"', '"extract tables to Excel"'];
  return `_You can also ask: ${tips.join(', ')}._`;
}
