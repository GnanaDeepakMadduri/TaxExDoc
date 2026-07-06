/**
 * ExtractionPanel.jsx — Extracted fields, form metadata, inline editing
 */
import { useState, useCallback } from 'react';

function EntityCard({ label, entity }) {
  return (
    <div className="entity-card">
      <div className="entity-card-label">{label}</div>
      <div className="entity-card-name">{entity.name || '—'}</div>
      <div className="entity-card-detail">
        {entity.ein && <div>EIN: <code>{entity.ein}</code></div>}
        {entity.tin && <div>TIN: <code>{entity.tin}</code></div>}
        {entity.address && <div>{entity.address}</div>}
      </div>
    </div>
  );
}

function FieldRow({ field, editedValue, onEdit }) {
  const conf = field.confidence || 'high';
  const current = editedValue !== undefined ? editedValue : (field.value ?? '');
  const isEdited = editedValue !== undefined && editedValue !== (field.value ?? '');

  return (
    <div className="field-row">
      <div className={`field-conf-dot conf-dot ${conf}`} title={`${conf} confidence`} />
      <div className="field-body">
        {field.box && <div className="field-box-num">{field.box}</div>}
        <div className="field-lbl">{field.label || field.id}</div>
        <input
          className={`field-input${isEdited ? ' edited' : ''}`}
          type="text"
          value={current}
          placeholder="—"
          onChange={e => onEdit(field.id, e.target.value, field.value ?? '')}
          aria-label={field.label || field.id}
        />
        {field.note && conf !== 'high' && (
          <div className="field-note">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {field.note}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ExtractionPanel({ doc, onExtract, onEditField }) {
  const canExtract = doc && doc.file; // only when actual File object present

  function renderBody() {
    if (!doc) {
      return (
        <div className="panel-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" style={{ color: 'var(--green-300)', opacity: 0.6 }}>
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          <div className="panel-state-title">No document selected</div>
          <div className="panel-state-sub">Upload a tax document and select it<br />from the queue to extract data.</div>
        </div>
      );
    }

    if (doc.status === 'pending') {
      return (
        <div className="panel-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" style={{ color: 'var(--green-300)' }}>
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          <div className="panel-state-title">{doc.name}</div>
          <div className="panel-state-sub">Click <strong>Extract with AI</strong> to analyze this document.</div>
        </div>
      );
    }

    if (doc.status === 'extracting') {
      return (
        <div className="panel-state">
          <div className="spinner" />
          <div className="panel-state-title">Analyzing document…</div>
          <div className="panel-state-sub">Gemini AI is reading your tax form.</div>
        </div>
      );
    }

    if (doc.status === 'error') {
      return (
        <div className="error-block">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--error)', opacity: 0.8 }}>
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div className="error-block-title">Extraction Failed</div>
          <div className="error-detail-box">{doc.errorMsg || 'Unknown error'}</div>
        </div>
      );
    }

    // status === 'done'
    const ex = doc.extraction;
    const edits = doc.edits || {};

    return (
      <>
        {ex.payer?.name && <EntityCard label="Payer / Employer" entity={ex.payer} />}
        {ex.recipient?.name && <EntityCard label="Recipient / Employee" entity={ex.recipient} />}

        {ex.fields?.length > 0 && (
          <>
            <div className="conf-legend">
              {[['high', 'High confidence'], ['medium', 'Medium'], ['low', 'Low — review']].map(([k, l]) => (
                <span key={k} className="conf-legend-item">
                  <span className={`conf-dot ${k}`} />
                  {l}
                </span>
              ))}
            </div>
            <div className="fields-section">
              <div className="fields-section-header">
                <span>Form Fields</span>
                <span style={{ color: 'var(--text-muted)' }}>{ex.fields.length} fields</span>
              </div>
              {ex.fields.map(field => (
                <FieldRow
                  key={field.id}
                  field={field}
                  editedValue={edits[field.id]}
                  onEdit={onEditField}
                />
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <section className="extraction-panel panel panel-border-left" aria-label="Extraction results">
      {/* Header */}
      <div className="extraction-header">
        <div className="extraction-title-row">
          <span className="extraction-title">Extracted Data</span>
          {doc?.status === 'done' && (
            <div className="extraction-header-actions">
              <button
                className="btn btn-ghost btn-sm btn-icon"
                title="Copy JSON"
                onClick={() => {
                  const data = buildExportData([doc])[0];
                  navigator.clipboard.writeText(JSON.stringify(data, null, 2))
                    .catch(() => {});
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Form meta */}
        <div className="form-meta-row">
          {doc?.status === 'done' && doc.extraction ? (
            <>
              <span className="form-type-badge">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {doc.extraction.formType}
              </span>
              {doc.extraction.taxYear && (
                <span className="tax-year-tag">Tax Year {doc.extraction.taxYear}</span>
              )}
              {doc.extraction.formDescription && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5, width: '100%' }}>
                  {doc.extraction.formDescription}
                </div>
              )}
            </>
          ) : doc?.status === 'error' ? (
            <span style={{ fontSize: 12, color: 'var(--error)', fontStyle: 'italic' }}>Extraction failed</span>
          ) : doc?.status === 'extracting' ? (
            <span className="meta-placeholder">Extracting…</span>
          ) : (
            <span className="meta-placeholder">
              {doc ? 'Ready to extract' : 'Select a document to begin'}
            </span>
          )}
        </div>
      </div>

      {/* Extract button */}
      {doc && (
        <div className="extract-zone">
          <button
            className="btn-extract"
            disabled={doc.status === 'extracting' || !doc.file}
            onClick={() => onExtract(doc.id)}
          >
            {doc.status === 'extracting' ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Extracting…
              </>
            ) : doc.status === 'done' ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                Re-extract
              </>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
                Extract with AI
              </>
            )}
          </button>
          {!doc.file && doc.status === 'pending' && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>
              Re-upload this file to extract
            </p>
          )}
        </div>
      )}

      {/* Progress bar */}
      {doc?.status === 'extracting' && (
        <div className="progress-track">
          <div className="progress-fill" />
        </div>
      )}

      {/* Main content */}
      <div className="extraction-body">
        {renderBody()}
      </div>
    </section>
  );
}

/**
 * Helper used by ExtractionPanel and ExportBar — merges edits into extraction data.
 * Exported so ExportBar can reuse it.
 */
export function buildExportData(docs) {
  return docs
    .filter(d => d.status === 'done' && d.extraction)
    .map(d => ({
      fileName: d.name,
      formType: d.extraction.formType,
      taxYear: d.extraction.taxYear,
      payer: d.extraction.payer,
      recipient: d.extraction.recipient,
      fields: (d.extraction.fields || []).map(f => ({
        ...f,
        value: d.edits?.[f.id] !== undefined ? d.edits[f.id] : f.value,
      })),
    }));
}
