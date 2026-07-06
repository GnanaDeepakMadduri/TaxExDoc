/**
 * DocumentViewer.jsx — PDF / image preview panel
 */
export default function DocumentViewer({ doc }) {
  const isPdf = doc
    ? doc.mimeType === 'application/pdf' || doc.name?.toLowerCase().endsWith('.pdf')
    : false;

  return (
    <section className="viewer panel panel-border-right" aria-label="Document viewer">
      {/* Top bar */}
      <div className="viewer-topbar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M9 21V9"/>
        </svg>
        <span className="viewer-doc-name">
          {doc ? doc.name : 'No document selected'}
        </span>
      </div>

      {/* Body */}
      <div className="viewer-body">
        {!doc ? (
          /* Empty — nothing selected */
          <div className="viewer-empty-state">
            <div className="viewer-empty-graphic">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
            </div>
            <div className="viewer-empty-title">No document selected</div>
            <div className="viewer-empty-sub">
              Upload a tax document from the sidebar,<br />then select it to preview here.
            </div>
          </div>
        ) : !doc.dataUrl ? (
          /* Session-restored doc — no file data available */
          <div className="viewer-no-file">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <p>{doc.name}</p>
            <small>Preview unavailable — re-upload the file to view it.</small>
          </div>
        ) : isPdf ? (
          <iframe
            className="viewer-pdf"
            src={doc.dataUrl}
            title={doc.name}
          />
        ) : (
          <img
            className="viewer-img"
            src={doc.dataUrl}
            alt={doc.name}
          />
        )}
      </div>
    </section>
  );
}
