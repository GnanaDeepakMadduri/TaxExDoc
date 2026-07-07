"""
main.py — FastAPI application for TaxExtract (standalone, no LLM)
"""

import logging
import os
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from backend.extractor import extract_document

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ─── App ───────────────────────────────────────────────────────────────────
app = FastAPI(
    title="TaxExtract API — Standalone",
    description=(
        "Local tax document data extraction using pdfplumber. "
        "No LLMs or external API keys required."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:5180",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5180",
        "https://gnanadeepakmadduri.github.io",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Supported MIME types ──────────────────────────────────────────────────
ALLOWED_MIME = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp"
}
MAX_FILE_BYTES = 30 * 1024 * 1024  # 30 MB


# ─── Routes ────────────────────────────────────────────────────────────────
@app.get("/api/health", tags=["System"])
def health():
    """Return extraction engine availability status."""
    return {
        "status":  "ok",
        "engines": {
            "pdfplumber": True,        # always available
        },
        "note": "Only digital PDF extraction is supported."
    }


@app.post("/api/extract", tags=["Extraction"])
async def extract(file: UploadFile = File(...)):
    """
    Upload a tax document and extract structured data locally.

    Supports:
    - Digital PDFs (W-2, 1099-*, 1098, 1040, K-1, W-9) via pdfplumber

    Returns a JSON object with formType, taxYear, payer, recipient, and fields.
    """
    # Normalise content-type
    content_type = file.content_type or ""
    if content_type == "image/jpg":
        content_type = "image/jpeg"

    if content_type in ("application/octet-stream", ""):
        name_lower = (file.filename or "").lower()
        if name_lower.endswith(".pdf"):
            content_type = "application/pdf"

    if content_type not in ALLOWED_MIME:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{content_type}'. Accepted: PDF and Images (JPG/PNG/TIFF).",
        )

    file_bytes = await file.read()

    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if len(file_bytes) > MAX_FILE_BYTES:
        mb = len(file_bytes) / 1_048_576
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({mb:.1f} MB). Maximum is 30 MB.",
        )

    logger.info("Extract request — file=%s mime=%s size=%d B",
                file.filename, content_type, len(file_bytes))

    try:
        result = extract_document(file_bytes, content_type)
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Unexpected extraction error")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {exc}")

    return result
