const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, ShadingType, LevelFormat, BorderStyle, PageNumber, Footer
} = require('docx');

const data = JSON.parse(fs.readFileSync('report_data.json', 'utf8'));

const numbering = {
  config: [{
    reference: 'bullets',
    levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360, hanging: 200 } } }
    }]
  }]
};

const children = [];

children.push(new Paragraph({
  heading: HeadingLevel.TITLE,
  children: [new TextRun('Windows Repair Dataset - Coverage Report')]
}));
children.push(new Paragraph({
  children: [new TextRun({ text: 'Files: repair-sessions.json & repair-dataset.jsonl  |  Total scenarios: ' + data.total + '  |  Domains: ' + data.domains.length, italics: true, size: 20 })],
  spacing: { after: 300 }
}));

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('1. Summary by Domain')] }));

// Summary table
const rows = [new TableRow({
  children: ['Domain', 'Entries'].map(t => new TableCell({
    width: { size: t === 'Domain' ? 7200 : 2160, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: '1F3864' },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: 'FFFFFF' })] })]
  }))
})];
for (const d of data.domains) {
  rows.push(new TableRow({
    children: [
      new TableCell({ width: { size: 7200, type: WidthType.DXA }, children: [new Paragraph(d.label + '  (' + d.key + ')')] }),
      new TableCell({ width: { size: 2160, type: WidthType.DXA }, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun(String(d.count))] })] })
    ]
  }));
}
children.push(new Table({ columnWidths: [7200, 2160], width: { size: 9360, type: WidthType.DXA }, rows }));

children.push(new Paragraph({ spacing: { before: 300 }, heading: HeadingLevel.HEADING_1, children: [new TextRun('2. Domains and Sub-domain Scenarios')] }));
children.push(new Paragraph({
  children: [new TextRun({ text: 'Every scenario (sub-domain problem) contained in the dataset, grouped under its domain.', italics: true, size: 20 })],
  spacing: { after: 200 }
}));

for (const d of data.domains) {
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240 },
    children: [new TextRun(d.label + ' - ' + d.count + ' scenario' + (d.count > 1 ? 's' : ''))]
  }));
  for (const g of d.goals) {
    children.push(new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      children: [new TextRun({ text: g, size: 20 })]
    }));
  }
}

const doc = new Document({
  numbering,
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22 } },
      heading1: { run: { size: 30, bold: true, color: '1F3864' } },
      heading2: { run: { size: 24, bold: true, color: '2E5395' } },
      title: { run: { size: 40, bold: true, color: '1F3864' } }
    }
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18 })] })] })
    },
    children
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('Windows-Repair-Dataset-Coverage.docx', buf);
  console.log('written', buf.length, 'bytes');
});
