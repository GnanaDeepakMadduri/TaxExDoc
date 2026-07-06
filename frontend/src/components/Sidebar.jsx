/**
 * Sidebar.jsx — Upload zone + document queue
 */
import { useRef, useState } from 'react';

const ALLOWED_EXTS = new Set(['.pdf']);
const MAX_SIZE = 30 * 1024 * 1024;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function statusLabel(s) {
  return { pending: 'Pending', extracting: 'AI…', done: 'Done', error: 'Error' }[s] ?? s;
}

export default function Sidebar({ docs, activeId, onSelect, onRemove, onAddFiles, onToast }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function validateAndAdd(files) {
    const valid = [];
    for (const f of files) {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) {
        onToast(`Unsupported format: ${f.name}`, 'error'); continue;
      }
      if (f.size > MAX_SIZE) {
        onToast(`File too large (max 30 MB): ${f.name}`, 'error'); continue;
      }
      valid.push(f);
    }
    if (valid.length) onAddFiles(valid);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    validateAndAdd(Array.from(e.dataTransfer.files));
  }

  return (
    <aside className="sidebar panel panel-border-right">
      {/* Upload */}
      <div className="sidebar-section" style={{ flexShrink: 0 }}>
        <div className="sidebar-section-label">Upload Documents</div>
        <div
          className={`upload-zone${dragging ? ' drag-active' : ''}`}
          onClick={() => inputRef.current.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current.click(); } }}
          onDragEnter={e => { e.preventDefault(); setDragging(true); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          aria-label="Upload tax documents"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf"
            multiple
            hidden
            onChange={e => { validateAndAdd(Array.from(e.target.files)); e.target.value = ''; }}
          />
          <div className="upload-icon-ring">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="upload-title">Drop files here</div>
          <div className="upload-hint">or click to browse</div>
          <div className="format-pills">
            {['PDF'].map(f => (
              <span key={f} className="format-pill">{f}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Queue header */}
      <div className="queue-header" style={{ flexShrink: 0 }}>
        <span className="sidebar-section-label" style={{ margin: 0 }}>Documents</span>
        <span className="queue-count">{docs.length}</span>
      </div>

      {/* Queue list */}
      <div className="queue-list" style={{ flex: 1, overflowY: 'auto' }}>
        {docs.length === 0 ? (
          <div className="queue-empty">
            <div className="queue-empty-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <p>No documents yet.<br />Upload a tax form to get started.</p>
          </div>
        ) : (
          docs.map(doc => (
            <div
              key={doc.id}
              className={`queue-item${doc.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(doc.id)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') onSelect(doc.id); }}
              aria-label={`Select ${doc.name}`}
            >
              <div className="doc-type-badge pdf">
                PDF
              </div>
              <div className="queue-item-info">
                <div className="queue-item-name" title={doc.name}>{doc.name}</div>
                <div className="queue-item-meta">{fmtSize(doc.size)}</div>
              </div>
              <span className={`status-chip status-${doc.status}`}>
                {statusLabel(doc.status)}
              </span>
              <button
                className="remove-btn"
                onClick={e => { e.stopPropagation(); onRemove(doc.id); }}
                aria-label={`Remove ${doc.name}`}
                title="Remove"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* Stats */}
      <div className="stats-bar">
        <div className="stat-cell">
          <div className="stat-num">{docs.length}</div>
          <div className="stat-lbl">Uploaded</div>
        </div>
        <div className="stat-cell">
          <div className="stat-num">{docs.filter(d => d.status === 'done').length}</div>
          <div className="stat-lbl">Extracted</div>
        </div>
      </div>
    </aside>
  );
}
