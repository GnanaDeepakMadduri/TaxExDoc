/**
 * TaxExtract — AI Tax Document Extraction
 * Author: Antigravity
 *
 * Architecture:
 *  - Pure client-side, no backend
 *  - State stored in-memory + localStorage (metadata only, no base64)
 *  - Gemini API (inline base64) for document understanding
 *  - ES2022, no bundler required
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const LS_KEY_APIKEY  = 'taxextract_apikey';
const LS_KEY_MODEL   = 'taxextract_model';
const LS_KEY_SESSION = 'taxextract_session';

const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/gif',
]);

const SUPPORTED_EXT = new Set(['.pdf','.jpg','.jpeg','.png','.tiff','.tif','.webp']);
const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Extraction prompt sent to Gemini.
 * Asks for strict JSON — no markdown, no prose.
 */
const EXTRACTION_PROMPT = `You are a highly accurate IRS tax document data extraction specialist. \
Analyze the provided document image or PDF and extract ALL tax information visible on the form.

Return ONLY a valid JSON object — no markdown, no code fences, no explanation — matching exactly this schema:

{
  "formType": "W-2" | "1099-NEC" | "1099-MISC" | "1099-INT" | "1099-DIV" | "1099-R" | "1099-B" | "1098" | "1095-A" | "1040" | "K-1" | "OTHER",
  "formDescription": "One sentence plain-English description of this form",
  "taxYear": "YYYY or null",
  "payer": {
    "name": "Payer / employer name, or null",
    "ein": "XX-XXXXXXX formatted, or null",
    "address": "Full address on one line, or null"
  },
  "recipient": {
    "name": "Recipient / employee name, or null",
    "tin": "Masked as XXX-XX-XXXX (SSN) or XX-XXXXXXX (EIN), or null",
    "address": "Full address on one line, or null"
  },
  "fields": [
    {
      "id": "unique_snake_case_id",
      "box": "Box number or letter printed on form, e.g. 'Box 1', or null",
      "label": "Official IRS label for this box/field exactly as printed",
      "value": "Extracted string value, include $ for currency, or null if blank",
      "confidence": "high" | "medium" | "low",
      "note": "Short note if confidence is medium/low, otherwise null"
    }
  ]
}

Extraction rules:
1. Extract EVERY field visible, even empty ones (use null for value).
2. Currency: always prefix with "$" and include commas, e.g. "$12,345.00".
3. SSNs/TINs: ALWAYS mask — SSN as "XXX-XX-XXXX", EIN as "XX-XXXXXXX".
4. confidence "high" = clearly legible; "medium" = partially obscured; "low" = guessed.
5. Add a note only for medium/low confidence explaining the uncertainty.
6. The "id" must be unique within the document, e.g. "wages_box1", "state_tax_box17".
7. Return ONLY the raw JSON with no surrounding text.`;


// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

const state = {
  apiKey: localStorage.getItem(LS_KEY_APIKEY) || '',
  model:  localStorage.getItem(LS_KEY_MODEL)  || 'gemini-2.0-flash',

  /** @type {TaxDocument[]} */
  docs: [],

  /** @type {string|null} Currently selected doc ID */
  activeId: null,
};

/**
 * @typedef {Object} TaxDocument
 * @property {string}      id
 * @property {string}      name
 * @property {number}      size
 * @property {string}      mimeType
 * @property {string|null} base64      - null when restored from session without file
 * @property {string|null} dataUrl     - null when restored
 * @property {'pending'|'extracting'|'done'|'error'} status
 * @property {object|null} extraction
 * @property {string|null} errorMsg
 * @property {Record<string,string>} edits  - fieldId → edited value
 * @property {number}      addedAt
 */

// Restore session metadata (no base64 — too large for localStorage)
try {
  const raw = localStorage.getItem(LS_KEY_SESSION);
  if (raw) {
    const { docs } = JSON.parse(raw);
    if (Array.isArray(docs)) {
      state.docs = docs.map(d => ({
        ...d,
        base64:  null,
        dataUrl: null,
        // docs that were extracting become pending
        status: d.status === 'extracting' ? 'pending' : d.status,
        edits: d.edits || {},
      }));
    }
  }
} catch (_) { /* corrupt session — ignore */ }


// ─────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────

const el = {
  // Header
  apiStatusPill: document.getElementById('api-status-pill'),
  apiStatusDot:  document.getElementById('api-status-dot'),
  apiStatusText: document.getElementById('api-status-text'),
  btnApiKey:     document.getElementById('btn-api-key'),
  btnApiKeyLbl:  document.getElementById('btn-api-key-label'),
  btnClear:      document.getElementById('btn-clear'),

  // Sidebar
  uploadZone:    document.getElementById('upload-zone'),
  fileInput:     document.getElementById('file-input'),
  queueList:     document.getElementById('queue-list'),
  queueEmpty:    document.getElementById('queue-empty'),
  queueCount:    document.getElementById('queue-count'),
  statTotal:     document.getElementById('stat-total'),
  statDone:      document.getElementById('stat-done'),

  // Viewer
  viewerFilename:    document.getElementById('viewer-filename'),
  viewerBody:        document.getElementById('viewer-body'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),

  // Extraction
  formMeta:           document.getElementById('form-meta'),
  extractZone:        document.getElementById('extract-zone'),
  btnExtract:         document.getElementById('btn-extract'),
  progressRail:       document.getElementById('progress-rail'),
  extractionBody:     document.getElementById('extraction-body'),
  exportBar:          document.getElementById('export-bar'),
  btnExportCSV:       document.getElementById('btn-export-csv'),
  btnExportJSON:      document.getElementById('btn-export-json'),
  btnCopyJSON:        document.getElementById('btn-copy-json'),
  extractionHdrBtns:  document.getElementById('extraction-header-btns'),

  // Modal
  modalBackdrop:  document.getElementById('modal-backdrop'),
  inputApiKey:    document.getElementById('input-api-key'),
  selectModel:    document.getElementById('select-model'),
  btnModalSave:   document.getElementById('btn-modal-save'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),

  // Toasts
  toastStack: document.getElementById('toast-stack'),
};


// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/** Generate a short random ID */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Format bytes to human-readable string */
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** HTML-escape a value */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert File → { base64, dataUrl } */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = /** @type {string} */ (reader.result);
      resolve({ dataUrl, base64: dataUrl.split(',')[1] });
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Trigger a file download in the browser */
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

/** Persist session to localStorage (no base64) */
function saveSession() {
  const docs = state.docs.map(({ base64, dataUrl, ...rest }) => rest);
  try {
    localStorage.setItem(LS_KEY_SESSION, JSON.stringify({ docs }));
  } catch (_) { /* quota exceeded — silently ignore */ }
}

/** Look up a document by id */
function getDoc(id) {
  return state.docs.find(d => d.id === id) ?? null;
}


// ─────────────────────────────────────────────────────────────
// TOAST SYSTEM
// ─────────────────────────────────────────────────────────────

const TOAST_ICONS = {
  success: '✓',
  error:   '✕',
  info:    '◆',
};

/**
 * @param {string} msg
 * @param {'success'|'error'|'info'} [type='info']
 * @param {number} [ms=4000]
 */
function toast(msg, type = 'info', ms = 4000) {
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]}</span><span>${esc(msg)}</span>`;
  el.toastStack.appendChild(div);
  setTimeout(() => {
    div.classList.add('removing');
    div.addEventListener('animationend', () => div.remove(), { once: true });
  }, ms);
}


// ─────────────────────────────────────────────────────────────
// API KEY & STATUS
// ─────────────────────────────────────────────────────────────

function updateApiStatus() {
  const connected = Boolean(state.apiKey);
  el.apiStatusPill.classList.toggle('connected', connected);
  el.apiStatusText.textContent = connected
    ? `${state.model}`
    : 'No API Key';
  el.btnApiKeyLbl.textContent = connected ? 'API Key ✓' : 'Set API Key';
}

function openModal() {
  el.inputApiKey.value = state.apiKey;
  el.selectModel.value = state.model;
  el.modalBackdrop.classList.add('is-open');
  setTimeout(() => el.inputApiKey.focus(), 120);
}

function closeModal() {
  el.modalBackdrop.classList.remove('is-open');
}

function saveModalSettings() {
  const key = el.inputApiKey.value.trim();
  if (!key) { toast('Please enter your Gemini API key', 'error'); return; }
  state.apiKey = key;
  state.model  = el.selectModel.value;
  localStorage.setItem(LS_KEY_APIKEY, key);
  localStorage.setItem(LS_KEY_MODEL,  state.model);
  updateApiStatus();
  closeModal();
  toast('API key saved — ready to extract!', 'success');
}


// ─────────────────────────────────────────────────────────────
// FILE HANDLING
// ─────────────────────────────────────────────────────────────

async function ingestFiles(files) {
  const list = Array.from(files);
  if (!list.length) return;

  let added = 0;
  for (const file of list) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    const mime = file.type || (ext === '.pdf' ? 'application/pdf' : '');

    if (!SUPPORTED_MIME.has(mime) && !SUPPORTED_EXT.has(ext)) {
      toast(`Unsupported format: ${file.name}`, 'error'); continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`File too large (max 30 MB): ${file.name}`, 'error'); continue;
    }

    try {
      const { dataUrl, base64 } = await readFile(file);
      const doc = {
        id:       uid(),
        name:     file.name,
        size:     file.size,
        mimeType: mime || (ext === '.pdf' ? 'application/pdf' : 'image/jpeg'),
        base64,
        dataUrl,
        status:   'pending',
        extraction: null,
        errorMsg: null,
        edits:    {},
        addedAt:  Date.now(),
      };
      state.docs.push(doc);
      appendQueueItem(doc);
      added++;
    } catch (e) {
      toast(`Could not read ${file.name}: ${e.message}`, 'error');
    }
  }

  if (added) {
    updateStats();
    // Auto-select the last added
    const last = state.docs[state.docs.length - 1];
    if (added === 1 || state.activeId === null) {
      selectDoc(last.id);
    }
    saveSession();
    if (added > 1) toast(`Added ${added} documents`, 'info');
  }
}


// ─────────────────────────────────────────────────────────────
// DOCUMENT QUEUE
// ─────────────────────────────────────────────────────────────

function appendQueueItem(doc) {
  el.queueEmpty.hidden = true;

  const isPdf = doc.mimeType === 'application/pdf' || doc.name.toLowerCase().endsWith('.pdf');
  const iconClass = isPdf ? 'pdf' : 'img';
  const iconSvg = isPdf
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>`;

  const item = document.createElement('div');
  item.className = 'queue-item';
  item.id = `qi-${doc.id}`;
  item.dataset.docId = doc.id;
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', `Select ${doc.name}`);

  item.innerHTML = `
    <div class="doc-icon ${iconClass}">${iconSvg}</div>
    <div class="queue-item-info">
      <div class="queue-item-name" title="${esc(doc.name)}">${esc(doc.name)}</div>
      <div class="queue-item-meta">${fmtSize(doc.size)}</div>
    </div>
    <span class="status-badge status-${doc.status}" id="badge-${doc.id}">${statusLabel(doc.status)}</span>
    <button class="item-remove-btn" data-remove="${doc.id}" title="Remove document" aria-label="Remove ${esc(doc.name)}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  item.addEventListener('click', e => {
    if (e.target.closest('[data-remove]')) return;
    selectDoc(doc.id);
  });
  item.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.target.closest('[data-remove]')) selectDoc(doc.id);
    }
  });
  item.querySelector('[data-remove]').addEventListener('click', e => {
    e.stopPropagation();
    removeDoc(doc.id);
  });

  el.queueList.appendChild(item);
}

function updateQueueBadge(docId, status) {
  const badge = document.getElementById(`badge-${docId}`);
  if (badge) {
    badge.className = `status-badge status-${status}`;
    badge.textContent = statusLabel(status);
  }
  const item = document.getElementById(`qi-${docId}`);
  if (item && status === 'done') {
    item.classList.add('is-active'); // keep selection visual
  }
}

function statusLabel(status) {
  return { pending: 'Pending', extracting: 'AI…', done: 'Done', error: 'Error' }[status] ?? status;
}

function selectDoc(docId) {
  state.activeId = docId;
  document.querySelectorAll('.queue-item').forEach(el => {
    el.classList.toggle('is-active', el.dataset.docId === docId);
  });
  const doc = getDoc(docId);
  if (doc) {
    renderViewer(doc);
    renderExtractionPanel(doc);
  }
}

function removeDoc(docId) {
  const idx = state.docs.findIndex(d => d.id === docId);
  if (idx === -1) return;
  state.docs.splice(idx, 1);
  document.getElementById(`qi-${docId}`)?.remove();

  if (state.activeId === docId) {
    const next = state.docs[Math.max(0, idx - 1)];
    if (next) selectDoc(next.id);
    else      clearAllPanels();
  }

  updateStats();
  saveSession();
  if (state.docs.length === 0) el.queueEmpty.hidden = false;
}

function updateStats() {
  const total = state.docs.length;
  const done  = state.docs.filter(d => d.status === 'done').length;
  el.queueCount.textContent = String(total);
  el.statTotal.textContent  = String(total);
  el.statDone.textContent   = String(done);
  if (total === 0) el.queueEmpty.hidden = false;
}

function clearAllPanels() {
  state.activeId = null;
  el.viewerFilename.textContent = 'No document selected';
  el.viewerPlaceholder.hidden = false;
  clearViewerMedia();
  renderExtractionEmpty();
  el.extractZone.hidden      = true;
  el.extractionHdrBtns.hidden = true;
  el.exportBar.hidden        = true;
  el.progressRail.hidden     = true;
  el.formMeta.innerHTML = `<span class="form-meta-placeholder">Select a document to begin</span>`;
}


// ─────────────────────────────────────────────────────────────
// DOCUMENT VIEWER
// ─────────────────────────────────────────────────────────────

function clearViewerMedia() {
  el.viewerBody.querySelectorAll('.viewer-pdf-frame, .viewer-image, .viewer-no-preview').forEach(e => e.remove());
}

function renderViewer(doc) {
  el.viewerFilename.textContent = doc.name;
  el.viewerPlaceholder.hidden = true;
  clearViewerMedia();

  if (!doc.dataUrl) {
    // Session-restored doc — file content unavailable
    const div = document.createElement('div');
    div.className = 'viewer-no-preview';
    div.innerHTML = `
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <p>${esc(doc.name)}</p>
      <small>File preview unavailable (session restored). Re-upload to view or re-extract.</small>
    `;
    el.viewerBody.appendChild(div);
    return;
  }

  const isPdf = doc.mimeType === 'application/pdf' || doc.name.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    const frame = document.createElement('iframe');
    frame.className = 'viewer-pdf-frame';
    frame.src = doc.dataUrl;
    frame.title = doc.name;
    el.viewerBody.appendChild(frame);
  } else {
    const img = document.createElement('img');
    img.className = 'viewer-image';
    img.src = doc.dataUrl;
    img.alt = doc.name;
    el.viewerBody.appendChild(img);
  }
}


// ─────────────────────────────────────────────────────────────
// EXTRACTION PANEL
// ─────────────────────────────────────────────────────────────

function renderExtractionPanel(doc) {
  // Extract button visibility
  el.extractZone.hidden = !doc.base64;
  el.btnExtract.disabled = doc.status === 'extracting';
  el.progressRail.hidden = doc.status !== 'extracting';

  if (doc.status === 'done') {
    el.btnExtract.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Re-extract`;
    el.extractionHdrBtns.hidden = false;
    el.exportBar.hidden = false;
  } else {
    el.btnExtract.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      Extract with AI`;
    el.extractionHdrBtns.hidden = true;
    if (doc.status !== 'done') el.exportBar.hidden = true;
  }

  // Update export bar regardless if any doc is done
  el.exportBar.hidden = !state.docs.some(d => d.status === 'done');

  switch (doc.status) {
    case 'pending':    renderExtractionPending(doc);   break;
    case 'extracting': renderExtractionLoading();       break;
    case 'done':       renderExtractionResult(doc);    break;
    case 'error':      renderExtractionError(doc);     break;
  }
}

function renderExtractionEmpty() {
  el.formMeta.innerHTML = `<span class="form-meta-placeholder">Select a document to begin</span>`;
  el.extractionBody.innerHTML = `
    <div class="panel-center">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.9" style="color:var(--primary)">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      <div class="panel-center-title">Ready to extract</div>
      <div class="panel-center-sub">Upload a tax document, select it,<br/>then click "Extract with AI"</div>
    </div>`;
}

function renderExtractionPending(doc) {
  el.formMeta.innerHTML = `<span class="form-meta-placeholder">Ready — click Extract to analyze</span>`;
  el.extractionBody.innerHTML = `
    <div class="panel-center">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.9" style="color:var(--primary)">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      <div class="panel-center-title">${esc(doc.name)}</div>
      <div class="panel-center-sub">${fmtSize(doc.size)} · Click "Extract with AI" above to analyze</div>
    </div>`;
}

function renderExtractionLoading() {
  el.formMeta.innerHTML = `<span class="form-meta-placeholder">Gemini AI is reading your document…</span>`;
  el.extractionBody.innerHTML = `
    <div class="panel-center">
      <div class="spinner"></div>
      <div class="panel-center-title">Analyzing document…</div>
      <div class="panel-center-sub loading-dots">Extracting fields</div>
    </div>`;
}

function renderExtractionError(doc) {
  el.formMeta.innerHTML = `<span style="font-size:12px;color:var(--error)">Extraction failed — check error below</span>`;
  el.extractionBody.innerHTML = `
    <div class="error-block">
      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--error);opacity:0.7">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div class="error-block-title">Extraction Failed</div>
      <div class="error-msg-box">${esc(doc.errorMsg || 'Unknown error')}</div>
    </div>`;
}

function renderExtractionResult(doc) {
  const ex = doc.extraction;

  // ── Form type header ──
  el.formMeta.innerHTML = '';
  if (ex.formType) {
    const chip = document.createElement('span');
    chip.className = 'form-type-chip';
    chip.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      ${esc(ex.formType)}`;
    el.formMeta.appendChild(chip);
  }
  if (ex.taxYear) {
    const yr = document.createElement('span');
    yr.className = 'tax-year-chip';
    yr.textContent = `Tax Year ${ex.taxYear}`;
    el.formMeta.appendChild(yr);
  }
  if (ex.formDescription) {
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:var(--text-2);margin-top:5px;line-height:1.5;width:100%';
    desc.textContent = ex.formDescription;
    el.formMeta.appendChild(desc);
  }

  // ── Main content ──
  el.extractionBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  // Entity cards
  if (ex.payer?.name) frag.appendChild(buildEntityCard('Payer / Employer', ex.payer));
  if (ex.recipient?.name) frag.appendChild(buildEntityCard('Recipient / Employee', ex.recipient));

  // Confidence legend
  if (ex.fields?.length) {
    const leg = document.createElement('div');
    leg.className = 'conf-legend';
    leg.innerHTML = `
      <span class="conf-legend-item"><span class="conf-dot high"></span>High confidence</span>
      <span class="conf-legend-item"><span class="conf-dot medium"></span>Medium</span>
      <span class="conf-legend-item"><span class="conf-dot low"></span>Low — review</span>
    `;
    frag.appendChild(leg);
  }

  // Fields
  if (ex.fields?.length) {
    const group = document.createElement('div');
    group.className = 'fields-group';

    const title = document.createElement('div');
    title.className = 'fields-group-title';
    title.innerHTML = `<span>Form Fields</span><span style="color:var(--text-3)">${ex.fields.length} fields</span>`;
    group.appendChild(title);

    for (const field of ex.fields) {
      group.appendChild(buildFieldRow(doc, field));
    }

    frag.appendChild(group);
  }

  el.extractionBody.appendChild(frag);
}

// ── Entity Card ──────────────────────────────────────────────

function buildEntityCard(label, entity) {
  const card = document.createElement('div');
  card.className = 'entity-card';
  const details = [
    entity.ein  ? `EIN: <code>${esc(entity.ein)}</code>`  : '',
    entity.tin  ? `TIN: <code>${esc(entity.tin)}</code>`  : '',
    entity.address ? esc(entity.address) : '',
  ].filter(Boolean).join('<br>');

  card.innerHTML = `
    <div class="entity-card-label">${esc(label)}</div>
    <div class="entity-card-name">${esc(entity.name)}</div>
    ${details ? `<div class="entity-card-details">${details}</div>` : ''}
  `;
  return card;
}

// ── Field Row ────────────────────────────────────────────────

function buildFieldRow(doc, field) {
  const row = document.createElement('div');
  row.className = 'field-row';

  const conf = field.confidence || 'high';
  const currentVal = doc.edits[field.id] !== undefined
    ? doc.edits[field.id]
    : (field.value ?? '');
  const isEdited = doc.edits[field.id] !== undefined;

  row.innerHTML = `
    <div class="field-conf-indicator conf-dot ${conf}" title="${conf} confidence"></div>
    <div class="field-body">
      ${field.box ? `<div class="field-box-label">${esc(field.box)}</div>` : ''}
      <div class="field-label">${esc(field.label || field.id)}</div>
      <input
        class="field-input${isEdited ? ' is-modified' : ''}"
        type="text"
        value="${esc(currentVal)}"
        data-field-id="${esc(field.id)}"
        data-original="${esc(field.value ?? '')}"
        placeholder="—"
        aria-label="${esc(field.label || field.id)}"
      />
      ${field.note && conf !== 'high' ? `
        <div class="field-note">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          ${esc(field.note)}
        </div>
      ` : ''}
    </div>
  `;

  const input = row.querySelector('.field-input');
  input.addEventListener('input', () => {
    const doc = getDoc(state.activeId);
    if (!doc) return;
    const newVal = input.value;
    const original = input.dataset.original;
    if (newVal !== original) {
      doc.edits[input.dataset.fieldId] = newVal;
      input.classList.add('is-modified');
    } else {
      delete doc.edits[input.dataset.fieldId];
      input.classList.remove('is-modified');
    }
    saveSession();
  });

  return row;
}


// ─────────────────────────────────────────────────────────────
// GEMINI EXTRACTION
// ─────────────────────────────────────────────────────────────

async function extractDoc(doc) {
  if (!state.apiKey) {
    toast('Please set your Gemini API key first', 'error');
    openModal();
    return;
  }
  if (!doc.base64) {
    toast('File data unavailable — please re-upload this document', 'error');
    return;
  }

  // Reset state
  doc.status    = 'extracting';
  doc.extraction = null;
  doc.errorMsg  = null;
  doc.edits     = {};

  updateQueueBadge(doc.id, 'extracting');
  renderExtractionPanel(doc);
  updateStats();

  try {
    const mimeType = doc.mimeType || 'image/jpeg';

    const body = {
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: doc.base64,
            },
          },
          { text: EXTRACTION_PROMPT },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.05,
        maxOutputTokens: 8192,
      },
    };

    const res = await fetch(
      `${GEMINI_BASE}/${state.model}:generateContent?key=${state.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        errMsg = errBody?.error?.message ?? errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await res.json();

    // Pull text out of response
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      const finishReason = data?.candidates?.[0]?.finishReason ?? 'UNKNOWN';
      throw new Error(
        `Gemini returned an empty response (finishReason: ${finishReason}). ` +
        `The document may be too large, corrupt, or in an unsupported format.`
      );
    }

    // Strip accidental markdown code fences
    let jsonText = rawText.trim();
    const fenceMatch = jsonText.match(/^```(?:json)?\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    const extraction = JSON.parse(jsonText);

    if (!extraction.formType) throw new Error('Gemini did not return a formType. The response may be malformed.');

    doc.extraction = extraction;
    doc.status     = 'done';

    toast(`Extracted ${extraction.formType} successfully`, 'success');

  } catch (err) {
    doc.status   = 'error';
    doc.errorMsg = err.message || String(err);
    toast(`Extraction failed: ${doc.errorMsg.slice(0, 80)}`, 'error', 6000);
  }

  updateQueueBadge(doc.id, doc.status);
  if (state.activeId === doc.id) renderExtractionPanel(doc);
  updateStats();
  saveSession();
}


// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

/** Get merged extraction data for a doc (applies user edits) */
function getMergedData(doc) {
  const ex = doc.extraction;
  return {
    fileName:    doc.name,
    formType:    ex.formType,
    taxYear:     ex.taxYear,
    payer:       ex.payer,
    recipient:   ex.recipient,
    fields:      (ex.fields || []).map(f => ({
      ...f,
      value: doc.edits[f.id] !== undefined ? doc.edits[f.id] : f.value,
    })),
  };
}

function exportCSV() {
  const extracted = state.docs.filter(d => d.status === 'done' && d.extraction);
  if (!extracted.length) { toast('No extracted documents to export', 'error'); return; }

  const headers = [
    'File Name', 'Form Type', 'Tax Year',
    'Payer Name', 'Payer EIN',
    'Recipient Name', 'Recipient TIN',
    'Box', 'Field Label', 'Value', 'Confidence',
  ];

  const csvRow = (cells) =>
    cells.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');

  const rows = [csvRow(headers)];

  for (const doc of extracted) {
    const d = getMergedData(doc);
    for (const f of d.fields) {
      rows.push(csvRow([
        d.fileName, d.formType, d.taxYear,
        d.payer?.name, d.payer?.ein,
        d.recipient?.name, d.recipient?.tin,
        f.box, f.label, f.value, f.confidence,
      ]));
    }
  }

  downloadBlob(
    `tax_extraction_${new Date().toISOString().slice(0, 10)}.csv`,
    rows.join('\r\n'),
    'text/csv;charset=utf-8;'
  );
  toast('CSV exported', 'success');
}

function exportJSON() {
  const extracted = state.docs.filter(d => d.status === 'done' && d.extraction);
  if (!extracted.length) { toast('No extracted documents to export', 'error'); return; }

  const payload = extracted.map(getMergedData);
  downloadBlob(
    `tax_extraction_${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
  toast('JSON exported', 'success');
}

function copyCurrentJSON() {
  const doc = getDoc(state.activeId);
  if (!doc?.extraction) { toast('No extraction data to copy', 'error'); return; }
  const text = JSON.stringify(getMergedData(doc), null, 2);
  navigator.clipboard.writeText(text)
    .then(() => toast('Copied JSON to clipboard', 'success'))
    .catch(() => toast('Clipboard copy failed', 'error'));
}


// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

// Upload zone
el.uploadZone.addEventListener('click', () => el.fileInput.click());
el.uploadZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', e => {
  ingestFiles(e.target.files);
  e.target.value = ''; // allow re-selecting same file
});

// Drag & drop
el.uploadZone.addEventListener('dragenter', e => { e.preventDefault(); el.uploadZone.classList.add('drag-active'); });
el.uploadZone.addEventListener('dragover',  e => { e.preventDefault(); el.uploadZone.classList.add('drag-active'); });
el.uploadZone.addEventListener('dragleave', e => {
  if (!el.uploadZone.contains(e.relatedTarget)) el.uploadZone.classList.remove('drag-active');
});
el.uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  el.uploadZone.classList.remove('drag-active');
  ingestFiles(e.dataTransfer.files);
});

// Extraction button
el.btnExtract.addEventListener('click', () => {
  const doc = getDoc(state.activeId);
  if (doc) extractDoc(doc);
});

// Export / copy
el.btnExportCSV.addEventListener('click', exportCSV);
el.btnExportJSON.addEventListener('click', exportJSON);
el.btnCopyJSON.addEventListener('click', copyCurrentJSON);

// API Key
el.btnApiKey.addEventListener('click', openModal);
el.btnModalSave.addEventListener('click', saveModalSettings);
el.btnModalCancel.addEventListener('click', closeModal);
el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) closeModal(); });
el.inputApiKey.addEventListener('keydown', e => { if (e.key === 'Enter') saveModalSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// Clear session
el.btnClear.addEventListener('click', () => {
  if (!state.docs.length) return;
  if (!confirm('Remove all documents from this session? Extracted data will be lost.')) return;
  state.docs = [];
  state.activeId = null;
  el.queueList.querySelectorAll('.queue-item').forEach(e => e.remove());
  el.queueEmpty.hidden = false;
  clearAllPanels();
  updateStats();
  localStorage.removeItem(LS_KEY_SESSION);
  toast('Session cleared', 'info');
});


// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────

function init() {
  updateApiStatus();

  // Rebuild queue from restored session
  for (const doc of state.docs) {
    appendQueueItem(doc);
  }

  updateStats();

  // Auto-select most recent extracted doc, else first doc
  if (state.docs.length > 0) {
    const prefer = state.docs.find(d => d.status === 'done') ?? state.docs[0];
    selectDoc(prefer.id);
  }

  // Prompt for API key if none is set
  if (!state.apiKey) {
    setTimeout(openModal, 600);
  }
}

init();
