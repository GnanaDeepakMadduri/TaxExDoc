/**
 * App.jsx — Root component (standalone mode — no API key required)
 * Manages global document state and orchestrates all panels.
 */
import { useState, useCallback } from 'react';
import { extractDocument } from './api/client.js';
import { useToast } from './hooks/useToast.js';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import DocumentViewer from './components/DocumentViewer.jsx';
import ExtractionPanel from './components/ExtractionPanel.jsx';
import ExportBar from './components/ExportBar.jsx';
import Toast from './components/Toast.jsx';

// ── Helpers ────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getMimeType(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return {
    pdf: 'application/pdf',
  }[ext] || 'application/octet-stream';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// ── Component ──────────────────────────────────────────────────
export default function App() {
  const [docs, setDocs]       = useState([]);
  const [activeId, setActiveId] = useState(null);
  const { toasts, addToast, removeToast } = useToast();

  const activeDoc = docs.find(d => d.id === activeId) ?? null;

  function updateDoc(id, patch) {
    setDocs(prev => prev.map(d => d.id === id ? { ...d, ...patch } : d));
  }

  // ── Add files ──────────────────────────────────────────────
  const handleAddFiles = useCallback(async (files) => {
    const newDocs = [];
    for (const file of files) {
      let dataUrl = null;
      try { dataUrl = await readFileAsDataUrl(file); }
      catch { addToast(`Could not read ${file.name}`, 'error'); continue; }

      newDocs.push({
        id:         uid(),
        name:       file.name,
        size:       file.size,
        mimeType:   getMimeType(file),
        file,
        dataUrl,
        status:     'pending',
        extraction: null,
        errorMsg:   null,
        edits:      {},
        addedAt:    Date.now(),
      });
    }

    if (!newDocs.length) return;
    setDocs(prev => [...prev, ...newDocs]);
    setActiveId(id => id ?? newDocs[0].id);
    if (newDocs.length > 1) addToast(`Added ${newDocs.length} documents`, 'info');
  }, [addToast]);

  // ── Remove ─────────────────────────────────────────────────
  const handleRemove = useCallback((id) => {
    setDocs(prev => {
      const next = prev.filter(d => d.id !== id);
      if (activeId === id) {
        const idx = prev.findIndex(d => d.id === id);
        setActiveId(next[Math.max(0, idx - 1)]?.id ?? null);
      }
      return next;
    });
  }, [activeId]);

  // ── Extract ────────────────────────────────────────────────
  const handleExtract = useCallback(async (id) => {
    const doc = docs.find(d => d.id === id);
    if (!doc?.file) {
      addToast('Re-upload this file to extract again', 'error');
      return;
    }

    updateDoc(id, { status: 'extracting', extraction: null, errorMsg: null, edits: {} });

    try {
      const result = await extractDocument(doc.file);
      updateDoc(id, { status: 'done', extraction: result });
      addToast(`Extracted ${result.formType || 'document'} successfully`, 'success');
    } catch (err) {
      const msg = err.message || String(err);
      updateDoc(id, { status: 'error', errorMsg: msg });
      addToast(`Extraction failed: ${msg.slice(0, 90)}`, 'error', 6000);
    }
  }, [docs, addToast]);

  // ── Edit field ─────────────────────────────────────────────
  const handleEditField = useCallback((fieldId, newValue, originalValue) => {
    setDocs(prev => prev.map(d => {
      if (d.id !== activeId) return d;
      const edits = { ...d.edits };
      if (newValue !== originalValue) edits[fieldId] = newValue;
      else delete edits[fieldId];
      return { ...d, edits };
    }));
  }, [activeId]);

  // ── Clear ──────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setDocs([]);
    setActiveId(null);
  }, []);

  return (
    <>
      <Header
        docCount={docs.length}
        onClear={handleClear}
      />

      <div className="main-layout" style={{ flex: 1, minHeight: 0 }}>
        <Sidebar
          docs={docs}
          activeId={activeId}
          onSelect={setActiveId}
          onRemove={handleRemove}
          onAddFiles={handleAddFiles}
          onToast={addToast}
        />

        <DocumentViewer doc={activeDoc} />

        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <ExtractionPanel
            doc={activeDoc}
            onExtract={handleExtract}
            onEditField={handleEditField}
          />
          <ExportBar docs={docs} onToast={addToast} />
        </div>
      </div>

      <Toast toasts={toasts} onRemove={removeToast} />
    </>
  );
}
