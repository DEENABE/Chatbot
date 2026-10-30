import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ChevronsUpDown, Copy, Download } from 'lucide-react';
import {
  compareCells,
  formatCell,
  isNumericCell,
  tableToCsv,
  tableToTsv,
} from './markdownTables.js';

const INDEX_HEADER = /^(#|row|no\.?|s\.?no\.?)$/i;

function saveCsv(header, rows) {
  const blob = new Blob([tableToCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `chanakya-table-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const toolButton =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/10 hover:text-white';

/**
 * A neat, sortable data table for spreadsheet answers.
 * Sticky header, zebra rows, right-aligned numbers, scrolls inside the chat
 * bubble, and the whole table can be copied (pastes into Excel) or saved as CSV.
 */
export default function DataTable({ header, rows, accent = '#3b82f6' }) {
  const [sort, setSort] = useState(null); // { column, direction: "asc" | "desc" }
  const [copied, setCopied] = useState(false);

  const numericColumns = useMemo(
    () =>
      header.map((_, column) => {
        const values = rows.map((row) => row[column]).filter((value) => value !== '');
        return values.length > 0 && values.filter(isNumericCell).length / values.length >= 0.8;
      }),
    [header, rows],
  );

  const visibleRows = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aBlank = String(a[sort.column] ?? '') === '';
      const bBlank = String(b[sort.column] ?? '') === '';
      if (aBlank !== bBlank) return aBlank ? 1 : -1; // blanks stay last either way
      return factor * compareCells(a[sort.column], b[sort.column]);
    });
  }, [rows, sort]);

  const toggleSort = (column) =>
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: 'asc' };
      if (current.direction === 'asc') return { column, direction: 'desc' };
      return null; // third click restores the original order
    });

  const copyTable = async () => {
    try {
      await navigator.clipboard.writeText(tableToTsv(header, visibleRows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — nothing useful to do */
    }
  };

  return (
    <div
      className="my-3 overflow-hidden rounded-xl border border-white/[0.08] bg-black/25"
      role="region"
      aria-label={`Table with ${rows.length} rows`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="text-[10px] text-stone-500">
          {rows.length} row{rows.length === 1 ? '' : 's'} · {header.length} column
          {header.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={copyTable} className={toolButton} aria-label="Copy table">
            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => saveCsv(header, visibleRows)}
            className={toolButton}
            aria-label="Download table as CSV"
          >
            <Download size={11} />
            CSV
          </button>
        </div>
      </div>

      <div className="max-h-[380px] overflow-auto">
        <table className="w-full border-collapse text-[11px] leading-4">
          <thead>
            <tr>
              {header.map((title, column) => {
                const isIndex = column === 0 && INDEX_HEADER.test(title);
                const active = sort?.column === column;
                const Icon = !active
                  ? ChevronsUpDown
                  : sort.direction === 'asc'
                    ? ChevronUp
                    : ChevronDown;
                return (
                  <th
                    key={column}
                    scope="col"
                    aria-sort={
                      active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className={`sticky top-0 z-10 border-b bg-[#18181c] p-0 align-bottom text-[10px] font-semibold uppercase tracking-wide text-stone-400 ${numericColumns[column] ? 'text-right' : 'text-left'}`}
                    style={{ borderBottomColor: `${accent}40` }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      title={`Sort by ${title}`}
                      className={`flex w-full items-end gap-1 px-2 py-2 transition-colors hover:text-white ${numericColumns[column] ? 'justify-end text-right' : 'justify-start text-left'} ${isIndex ? 'min-w-[2rem]' : 'min-w-[3.5rem]'}`}
                      style={active ? { color: accent } : undefined}
                    >
                      <span className="max-w-[112px] break-words leading-3">{title}</span>
                      <Icon size={10} className={`shrink-0 ${active ? '' : 'opacity-40'}`} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="transition-colors even:bg-white/[0.025] hover:bg-white/[0.06]"
              >
                {row.map((cell, column) => {
                  const isIndex = column === 0 && INDEX_HEADER.test(header[0]);
                  const shown = isIndex
                    ? cell
                    : formatCell(header[column], cell, numericColumns[column]);
                  return (
                    <td
                      key={column}
                      className={`whitespace-nowrap border-b border-white/[0.04] px-2 py-1.5 ${
                        isIndex
                          ? 'text-stone-600 tabular-nums'
                          : numericColumns[column]
                            ? 'text-right tabular-nums text-stone-100'
                            : 'text-left text-stone-200'
                      }`}
                    >
                      {isIndex || numericColumns[column] ? (
                        shown
                      ) : (
                        <span className="block max-w-[260px] truncate" title={String(cell)}>
                          {shown === '' ? <span className="text-stone-700">—</span> : shown}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
