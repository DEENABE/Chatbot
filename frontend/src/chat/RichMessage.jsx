import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import DataTable from './DataTable.jsx';
import { splitMarkdownTables } from './markdownTables.js';

/**
 * Assistant message body: normal markdown for text, a real data table for any
 * markdown table (react-markdown alone renders those as run-on text).
 */
export default function RichMessage({ content, accent }) {
  const segments = useMemo(() => splitMarkdownTables(content || ''), [content]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'table') {
          return (
            <DataTable key={index} header={segment.header} rows={segment.rows} accent={accent} />
          );
        }
        return segment.text.trim() ? (
          <ReactMarkdown key={index}>{segment.text}</ReactMarkdown>
        ) : null;
      })}
    </>
  );
}
