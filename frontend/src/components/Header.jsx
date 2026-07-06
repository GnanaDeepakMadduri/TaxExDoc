/**
 * Header.jsx — Grove-branded top navigation (standalone mode)
 * Shows pdfplumber + OCR engine availability from /api/health
 */
import { useState, useEffect, useCallback } from 'react';
import { checkHealth } from '../api/client.js';

export default function Header({ docCount, onClear }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  const poll = useCallback(async (retries = 4, delayMs = 1500) => {
    for (let i = 0; i <= retries; i++) {
      try {
        const h = await checkHealth();
        setHealth(h);
        setLoading(false);
        return;
      } catch (_) {
        if (i < retries) await new Promise(r => setTimeout(r, delayMs));
      }
    }
    setHealth(null);
    setLoading(false);
  }, []);

  useEffect(() => { poll(); }, [poll]);

  const connected  = health?.status === 'ok';
  const hasPdf     = health?.engines?.pdfplumber;

  function statusText() {
    if (loading)    return 'Connecting…';
    if (!connected) return 'Backend offline — start uvicorn';
    if (!hasPdf)    return 'Backend error';
    return 'PDF Ready';
  }

  return (
    <header className="header">
      {/* Brand */}
      <div className="header-brand">
        <div className="brand-logo-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 8C8 10 5.9 16.17 3.82 19.93c-.36.67.05 1.07.43.68C6.95 18.32 10.28 17 17 17c0 0 0 0 0 0 2 0 5-1 5-5s-5-4-5-4z"/>
            <line x1="7" y1="19" x2="17" y2="9"/>
          </svg>
        </div>
        <span className="brand-wordmark">TaxExtract</span>
        <span className="brand-separator" />
        <span className="brand-product">Standalone · No AI Required</span>
      </div>

      {/* Engine status */}
      <div className="header-center">
        <div className={`connection-pill${connected ? ' ready' : ''}`}>
          <span className="connection-dot" />
          {statusText()}
        </div>

        {/* Engine badges when connected */}
        {connected && (
          <div style={{ display: 'flex', gap: 5 }}>
            <span className="engine-badge engine-ok" title="PDF text extraction">
              PDF
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="header-actions">
        {docCount > 0 && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => { if (window.confirm('Clear all documents from this session?')) onClear(); }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
            </svg>
            Clear Session
          </button>
        )}
      </div>
    </header>
  );
}
