/**
 * client.js — API wrapper for the FastAPI backend
 */

const API_BASE = '/api';

/**
 * Upload a file and extract tax data.
 * @param {File} file - The tax document file.
 * @param {(pct: number) => void} [onProgress] - Optional progress callback (0–100).
 * @returns {Promise<object>} Extraction result JSON.
 */
export async function extractDocument(file, onProgress) {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/extract`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    let errMsg = `Server error ${res.status}`;
    try {
      const body = await res.json();
      errMsg = body.detail || errMsg;
    } catch (_) { /* ignore */ }
    throw new Error(errMsg);
  }

  return res.json();
}

/**
 * Check API health — returns { status, apiKeyConfigured, model }.
 * @returns {Promise<object>}
 */
export async function checkHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}
