/**
 * ExportBar.jsx — CSV and JSON export controls
 */
import { buildExportData } from './ExtractionPanel.jsx';

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ExportBar({ docs, onToast }) {
  const extractedDocs = docs.filter(d => d.status === 'done' && d.extraction);
  if (!extractedDocs.length) return null;

  function handleCSV() {
    const data = buildExportData(extractedDocs);
    const headers = [
      'File Name', 'Form Type', 'Tax Year',
      'Payer Name', 'Payer EIN',
      'Recipient Name', 'Recipient TIN',
      'Box', 'Field Label', 'Value', 'Confidence',
    ];
    const csvRow = cells =>
      cells.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');

    const rows = [csvRow(headers)];
    for (const d of data) {
      for (const f of d.fields || []) {
        rows.push(csvRow([
          d.fileName, d.formType, d.taxYear,
          d.payer?.name, d.payer?.ein,
          d.recipient?.name, d.recipient?.tin,
          f.box, f.label, f.value, f.confidence,
        ]));
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(`tax_extraction_${date}.csv`, rows.join('\r\n'), 'text/csv;charset=utf-8;');
    onToast('CSV exported successfully', 'success');
  }

  function handleJSON() {
    const data = buildExportData(extractedDocs);
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(`tax_extraction_${date}.json`, JSON.stringify(data, null, 2), 'application/json');
    onToast('JSON exported successfully', 'success');
  }

  return (
    <div className="export-bar">
      <span className="export-bar-label">
        Export {extractedDocs.length} extracted document{extractedDocs.length !== 1 ? 's' : ''}
      </span>
      <button className="btn btn-outline btn-sm" onClick={handleCSV}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        CSV
      </button>
      <button className="btn btn-outline btn-sm" onClick={handleJSON}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        JSON
      </button>
    </div>
  );
}
