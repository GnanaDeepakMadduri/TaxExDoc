# TaxExtract — AI Tax Document Extraction

A full-stack tax document extraction tool built for tax preparers. Upload W-2, 1099, 1098, 1040, and other IRS forms and instantly extract structured data using Google Gemini AI.

## Architecture

| Layer | Tech |
|---|---|
| Backend API | Python · FastAPI · Uvicorn |
| AI Extraction | Google Gemini (`gemini-2.0-flash`) |
| Frontend | React 18 · Vite |
| Styling | Vanilla CSS (Grove-inspired design) |

## Quick Start

### 1. Backend

```bash
cd backend

# Copy the env template and add your Gemini API key
copy .env.example .env
# Edit .env — paste your GEMINI_API_KEY

# Install Python dependencies
pip install -r requirements.txt

# Start the API server
uvicorn main:app --reload --port 8000
```

Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

## Usage

1. **Drop a tax document** — PDF, JPG, PNG, TIFF (max 30 MB)
2. **Click "Extract with AI"** — Gemini reads the form and returns all fields
3. **Edit any field inline** — edits are highlighted in green
4. **Export** — download all extracted documents as CSV or JSON

## Supported Tax Forms

W-2, 1099-NEC, 1099-MISC, 1099-INT, 1099-DIV, 1099-R, 1099-B, 1098, 1095-A, 1040, Schedule K-1

## Project Structure

```
Groove/
├── backend/
│   ├── main.py          # FastAPI endpoints
│   ├── extractor.py     # Gemini extraction logic
│   ├── requirements.txt
│   └── .env             # Your API key (never commit)
└── frontend/
    ├── src/
    │   ├── App.jsx
    │   ├── index.css    # Grove design system
    │   ├── api/client.js
    │   ├── hooks/
    │   └── components/
    ├── vite.config.js   # Proxies /api → localhost:8000
    └── package.json
```
