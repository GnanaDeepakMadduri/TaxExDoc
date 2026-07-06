"""
extractor.py — Standalone tax document extraction (no LLMs)
=============================================================
Processing pipeline:
  Digital PDF   →  pdfplumber text extraction  →  regex field matching
  Image / Scan  →  OpenCV preprocessing         →  pytesseract OCR  →  regex field matching

No API keys or internet connection required after initial setup.
"""

import io
import logging
import os
import re
from collections import Counter
from typing import Dict, List, Optional, Tuple

import pdfplumber

logger = logging.getLogger(__name__)


# ─── Regex helpers ─────────────────────────────────────────────────────────
# Dollar amounts: 50,000 / 50,000.00 / $8,500.00 / 111.34 / 2619 …
# Requires either: a comma-grouped cluster (1,000+), a decimal point, or 3+ digits.
# Intentionally excludes bare 1-2 digit integers (box labels) AND digit sequences
# that are part of hyphenated ID numbers (EIN, SSN, state employee IDs like ME-0100332).
#
# Lookbehind (?<![.\d\-]) — don't match if preceded by dot, digit, or hyphen.
#   Catches the "0100332" in "ME-0100332" (preceded by "-").
# Lookahead  (?![\-]\d)   — don't match if followed by hyphen+digit.
#   Catches "727" in "727-18-3051" (followed by "-1").
AMOUNT_RE = re.compile(
    r"(?<![.\d\-])\$?\s*((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{3,}|\b\d{1,2}(?!\s*[A-Za-z])))(?![\-]\d)\b"
)
EIN_RE   = re.compile(r"\b(\d{2}-\d{7})\b")
SSN_RE   = re.compile(r"\b(\d{3}-\d{2}-\d{4})\b")
YEAR_RE  = re.compile(r"\b(20[12]\d)\b")
DATE_RE  = re.compile(r"\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})\b")

# Pipe-separated table row splitter (matches rows produced by pdfplumber table extraction)
_TABLE_SEP_RE = re.compile(r"\s*\|\s*")

# Box labels often continue past the phrase a field's pattern anchors on
# (e.g. "Employer's name, address, and zip code" as ONE printed label for
# both a name and address field). Text matching this is almost certainly
# leftover label wording, not an actual extracted value.
_LABEL_CONTINUATION_RE = re.compile(
    r"\b(address|zip\s*code|initial|last\s+name|first\s+name|box\s*\d+|"
    r"tips|wages|tax|security|medicare|allocated)\b",
    re.IGNORECASE,
)


# ─── Form type signatures ──────────────────────────────────────────────────
FORM_SIGNATURES: Dict[str, List[str]] = {
    "W-2": [
        "wage and tax statement",
        "social security wages",
        "medicare wages",
        "employer identification number",
        "w-2",
    ],
    "1099-NEC": [
        "nonemployee compensation",
        "1099-nec",
        "non-employee",
    ],
    "1099-MISC": [
        "miscellaneous income",
        "1099-misc",
        "fishing boat proceeds",
    ],
    "1099-INT": [
        "interest income",
        "1099-int",
        "payer's routing",
        "accrued interest",
    ],
    "1099-DIV": [
        "dividends and distributions",
        "1099-div",
        "ordinary dividends",
        "qualified dividends",
    ],
    "1099-R": [
        "distributions from pensions",
        "1099-r",
        "gross distribution",
        "taxable amount not determined",
    ],
    "1098": [
        "mortgage interest statement",
        "1098",
        "mortgage interest received",
        "outstanding mortgage principal",
    ],
    "1040": [
        "individual income tax return",
        "form 1040",
        "adjusted gross income",
        "standard deduction",
    ],
    "K-1": [
        "partner's share",
        "schedule k-1",
        "shareholder's share",
        "beneficiary's share",
    ],
    "W-9": [
        "request for taxpayer identification number",
        "form w-9",
    ],
}

FORM_DESCRIPTIONS: Dict[str, str] = {
    "W-2":      "Wage and Tax Statement",
    "1099-NEC": "Nonemployee Compensation",
    "1099-MISC":"Miscellaneous Income",
    "1099-INT": "Interest Income",
    "1099-DIV": "Dividends and Distributions",
    "1099-R":   "Distributions from Pensions, Annuities, Retirement Plans",
    "1098":     "Mortgage Interest Statement",
    "1040":     "U.S. Individual Income Tax Return",
    "K-1":      "Partner's / Shareholder's Share of Income",
    "W-9":      "Request for Taxpayer Identification Number and Certification",
    "OTHER":    "Tax Document",
}


# ─── Field definitions ─────────────────────────────────────────────────────
# Tuple: (field_id, box_label, display_label, [search_patterns], value_type)
# value_type: "amount" | "code" | "date" | "text"
FORM_FIELDS: Dict[str, List[Tuple]] = {
    "W-2": [
        ("employer_name",       "Box c",  "Employer's Name",
         [r"employer.s\s+name", r"employer\s+name"], "long_text"),
        ("employer_address",    "Box c",  "Employer's Address",
         [r"employer.s\s+name.*address", r"employer.s\s+address"], "long_text"),
        ("employee_name",       "Box e",  "Employee's Name",
         [r"employee.s\s+(?:first\s+)?name", r"employee\s+name"], "long_text"),
        ("employee_address",    "Box f",  "Employee's Address",
         [r"employee.s\s+address"], "long_text"),
        # NOTE: box-number fallback patterns (r"\bbox\s*N\b") intentionally omitted.
        # They match the printed box label numbers on the form and cause false positives
        # when the extractor picks up the neighbouring box's label as the value.
        ("wages_box1",          "Box 1",  "Wages, Tips, Other Compensation",
         [r"wages[\s,]+tips[\s,]+other\s+comp"], "amount"),
        ("federal_tax_box2",    "Box 2",  "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld"], "amount"),
        ("ss_wages_box3",       "Box 3",  "Social Security Wages",
         [r"social\s+security\s+wages"], "amount"),
        ("ss_tax_box4",         "Box 4",  "Social Security Tax Withheld",
         [r"social\s+security\s+tax\s+withheld"], "amount"),
        ("medicare_wages_box5", "Box 5",  "Medicare Wages and Tips",
         [r"medicare\s+wages\s+and\s+tips"], "amount"),
        ("medicare_tax_box6",   "Box 6",  "Medicare Tax Withheld",
         [r"medicare\s+tax\s+withheld"], "amount"),
        ("ss_tips_box7",        "Box 7",  "Social Security Tips",
         [r"social\s+security\s+tips"], "amount"),
        ("allocated_tips_box8", "Box 8",  "Allocated Tips",
         [r"allocated\s+tips"], "amount"),
        ("dep_care_box10",      "Box 10", "Dependent Care Benefits",
         [r"dependent\s+care\s+benefits"], "amount"),
        ("nonqual_box11",       "Box 11", "Nonqualified Plans",
         [r"nonqualified\s+plans"], "amount"),
        ("state_wages_box16",   "Box 16", "State Wages, Tips, etc.",
         [r"state\s+wages[\s,]+tips", r"state\s+wages,?\s+tips"], "amount"),
        ("state_tax_box17",     "Box 17", "State Income Tax",
         [r"state\s+income\s+tax"], "amount"),
        ("local_wages_box18",   "Box 18", "Local Wages, Tips, etc.",
         [r"local\s+wages"], "amount"),
        ("local_tax_box19",     "Box 19", "Local Income Tax",
         [r"local\s+income\s+tax"], "amount"),
    ],
    "1099-NEC": [
        ("payer_name",        None, "Payer's Name",
         [r"payer.s\s+name", r"payer\s+name"], "long_text"),
        ("recipient_name",    None, "Recipient's Name",
         [r"recipient.s\s+name"], "long_text"),
        ("nonemployee_box1",  "Box 1", "Nonemployee Compensation",
         [r"nonemployee\s+compensation", r"non-employee\s+comp", r"\bbox\s*1\b"], "amount"),
        ("direct_sales_box2", "Box 2", "Direct Sales of $5,000 or More",
         [r"direct\s+sales", r"\bbox\s*2\b"], "text"),
        ("federal_tax_box4",  "Box 4", "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld", r"\bbox\s*4\b"], "amount"),
        ("state_tax_box5",    "Box 5", "State Tax Withheld",
         [r"state\s+tax\s+withheld", r"\bbox\s*5\b"], "amount"),
        ("state_income_box7", "Box 7", "State Income",
         [r"\bstate\s+income\b", r"\bbox\s*7\b"], "amount"),
    ],
    "1099-MISC": [
        ("payer_name",           None, "Payer's Name",
         [r"payer.s\s+name", r"payer\s+name"], "long_text"),
        ("recipient_name",       None, "Recipient's Name",
         [r"recipient.s\s+name"], "long_text"),
        ("rents_box1",           "Box 1",  "Rents",
         [r"\brents\b", r"\bbox\s*1\b"], "amount"),
        ("royalties_box2",       "Box 2",  "Royalties",
         [r"\broyalties\b", r"\bbox\s*2\b"], "amount"),
        ("other_income_box3",    "Box 3",  "Other Income",
         [r"\bother\s+income\b", r"\bbox\s*3\b"], "amount"),
        ("federal_tax_box4",     "Box 4",  "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld", r"\bbox\s*4\b"], "amount"),
        ("medical_box6",         "Box 6",  "Medical and Health Care Payments",
         [r"medical\s+and\s+health", r"\bbox\s*6\b"], "amount"),
        ("substitute_box8",      "Box 8",  "Substitute Payments in Lieu of Dividends",
         [r"substitute\s+payments", r"\bbox\s*8\b"], "amount"),
        ("crop_box9",            "Box 9",  "Crop Insurance Proceeds",
         [r"crop\s+insurance", r"\bbox\s*9\b"], "amount"),
        ("gross_proceeds_box10", "Box 10", "Gross Proceeds Paid to Attorney",
         [r"gross\s+proceeds", r"\bbox\s*10\b"], "amount"),
        ("state_tax_box16",      "Box 16", "State Tax Withheld",
         [r"state\s+tax\s+withheld", r"\bbox\s*16\b"], "amount"),
    ],
    "1099-INT": [
        ("interest_income_box1",  "Box 1",  "Interest Income",
         [r"interest\s+income", r"interest\s+earned", r"\bbox\s*1\b"], "amount"),
        ("early_withdrawal_box2", "Box 2",  "Early Withdrawal Penalty",
         [r"early\s+withdrawal", r"\bbox\s*2\b"], "amount"),
        ("us_savings_box3",       "Box 3",  "Interest on U.S. Savings Bonds and Treasuries",
         [r"savings\s+bonds?", r"u\.s\.\s+savings", r"\bbox\s*3\b"], "amount"),
        ("federal_tax_box4",      "Box 4",  "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld", r"\bbox\s*4\b"], "amount"),
        ("tax_exempt_box8",       "Box 8",  "Tax-Exempt Interest",
         [r"tax.exempt\s+interest", r"\bbox\s*8\b"], "amount"),
        ("market_discount_box10", "Box 10", "Market Discount",
         [r"market\s+discount", r"\bbox\s*10\b"], "amount"),
        ("bond_premium_box11",    "Box 11", "Bond Premium",
         [r"bond\s+premium", r"\bbox\s*11\b"], "amount"),
        ("state_tax_box17",       "Box 17", "State Tax Withheld",
         [r"state\s+tax\s+withheld", r"\bbox\s*17\b"], "amount"),
    ],
    "1099-DIV": [
        ("total_ord_div_box1a",   "Box 1a", "Total Ordinary Dividends",
         [r"total\s+ordinary\s+dividends?", r"ordinary\s+dividends?", r"\bbox\s*1a\b"], "amount"),
        ("qualified_div_box1b",   "Box 1b", "Qualified Dividends",
         [r"qualified\s+dividends?", r"\bbox\s*1b\b"], "amount"),
        ("total_cap_gain_box2a",  "Box 2a", "Total Capital Gain Distributions",
         [r"total\s+capital\s+gain", r"capital\s+gain\s+distr", r"\bbox\s*2a\b"], "amount"),
        ("unrecap_box2b",         "Box 2b", "Unrecap. Sec. 1250 Gain",
         [r"unrecap", r"1250\s+gain", r"\bbox\s*2b\b"], "amount"),
        ("nondividend_box3",      "Box 3",  "Nondividend Distributions",
         [r"nondividend\s+distributions?", r"\bbox\s*3\b"], "amount"),
        ("federal_tax_box4",      "Box 4",  "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld", r"\bbox\s*4\b"], "amount"),
        ("sec199a_box5",          "Box 5",  "Section 199A Dividends",
         [r"199a\s+dividends?", r"\bbox\s*5\b"], "amount"),
        ("foreign_tax_box7",      "Box 7",  "Foreign Tax Paid",
         [r"foreign\s+tax\s+paid", r"\bbox\s*7\b"], "amount"),
        ("exempt_interest_box12", "Box 12", "Exempt-Interest Dividends",
         [r"exempt.interest\s+dividends?", r"\bbox\s*12\b"], "amount"),
        ("state_tax_box16",       "Box 16", "State Tax Withheld",
         [r"state\s+tax\s+withheld", r"\bbox\s*16\b"], "amount"),
    ],
    "1099-R": [
        ("gross_dist_box1",   "Box 1",  "Gross Distribution",
         [r"gross\s+distribution", r"\bbox\s*1\b"], "amount"),
        ("taxable_box2a",     "Box 2a", "Taxable Amount",
         [r"\btaxable\s+amount\b", r"\bbox\s*2a\b"], "amount"),
        ("cap_gain_box3",     "Box 3",  "Capital Gain (Included in Box 2a)",
         [r"\bcapital\s+gain\b", r"\bbox\s*3\b"], "amount"),
        ("federal_tax_box4",  "Box 4",  "Federal Income Tax Withheld",
         [r"federal\s+income\s+tax\s+withheld", r"\bbox\s*4\b"], "amount"),
        ("dist_code_box7",    "Box 7",  "Distribution Code(s)",
         [r"distribution\s+code", r"\bbox\s*7\b"], "code"),
        ("state_tax_box12",   "Box 12", "State Tax Withheld",
         [r"state\s+tax\s+withheld", r"\bbox\s*12\b"], "amount"),
        ("state_dist_box14",  "Box 14", "State Distribution",
         [r"state\s+distribution", r"\bbox\s*14\b"], "amount"),
    ],
    "1098": [
        ("mortgage_interest_box1",     "Box 1", "Mortgage Interest Received from Borrower(s)",
         [r"mortgage\s+interest\s+received", r"\bbox\s*1\b"], "amount"),
        ("outstanding_principal_box2", "Box 2", "Outstanding Mortgage Principal",
         [r"outstanding\s+mortgage\s+principal", r"\bbox\s*2\b"], "amount"),
        ("origination_date_box3",      "Box 3", "Mortgage Origination Date",
         [r"origination\s+date", r"mortgage\s+origination", r"\bbox\s*3\b"], "date"),
        ("refund_box4",                "Box 4", "Refund of Overpaid Interest",
         [r"refund\s+of\s+overpaid", r"\bbox\s*4\b"], "amount"),
        ("insurance_premiums_box5",    "Box 5", "Mortgage Insurance Premiums",
         [r"mortgage\s+insurance\s+premiums?", r"\bbox\s*5\b"], "amount"),
        ("points_box6",                "Box 6", "Points Paid on Purchase of Principal Residence",
         [r"points\s+paid", r"\bbox\s*6\b"], "amount"),
    ],
    "1040": [
        ("filing_status",            None, "Filing Status",
         [r"single", r"married\s+filing\s+jointly", r"married\s+filing\s+separately", r"head\s+of\s+household", r"qualifying\s+surviving\s+spouse"], "long_text"),
        ("wages_line1z",             None, "Wages, Salaries, Tips (Line 1z)",
         [r"wages[\s,]+salaries[\s,]+tips", r"line\s*1[az]?\b"], "amount"),
        ("taxable_interest_line2b",  None, "Taxable Interest (Line 2b)",
         [r"taxable\s+interest", r"line\s*2b\b"], "amount"),
        ("dividends_line3b",         None, "Ordinary Dividends (Line 3b)",
         [r"ordinary\s+dividends?", r"line\s*3b\b"], "amount"),
        ("total_income_line9",       None, "Total Income (Line 9)",
         [r"\btotal\s+income\b", r"line\s*9\b"], "amount"),
        ("agi_line11",               None, "Adjusted Gross Income (Line 11)",
         [r"adjusted\s+gross\s+income", r"line\s*11\b"], "amount"),
        ("std_deduction_line12",     None, "Standard or Itemized Deductions (Line 12)",
         [r"standard\s+deduction", r"itemized\s+deductions?", r"line\s*12\b"], "amount"),
        ("taxable_income_line15",    None, "Taxable Income (Line 15)",
         [r"\btaxable\s+income\b", r"line\s*15\b"], "amount"),
        ("child_tax_credit_line19",  None, "Child Tax Credit (Line 19)",
         [r"child\s+tax\s+credit", r"line\s*19\b"], "amount"),
        ("total_tax_line24",         None, "Total Tax (Line 24)",
         [r"\btotal\s+tax\b", r"line\s*24\b"], "amount"),
        ("fed_withheld_line25a",     None, "Federal Tax Withheld — W-2s (Line 25a)",
         [r"federal\s+tax\s+withheld", r"line\s*25a?\b"], "amount"),
        ("total_fed_tax_line25d",    None, "Total Federal Income Tax Withheld (Line 25d)",
         [r"total\s+federal\s+income\s+tax\s+withheld", r"line\s*25d?\b"], "amount"),
        ("refund_line35a",           None, "Amount Refunded to You (Line 35a)",
         [r"\brefund\b", r"line\s*35a?\b"], "amount"),
        ("amount_owed_line37",       None, "Amount You Owe (Line 37)",
         [r"amount\s+you\s+owe", r"line\s*37\b"], "amount"),
    ],
    "K-1": [
        ("ordinary_income_box1", "Box 1",  "Ordinary Business Income (Loss)",
         [r"ordinary\s+business\s+income", r"\bbox\s*1\b"], "amount"),
        ("net_rental_box2",      "Box 2",  "Net Rental Real Estate Income (Loss)",
         [r"net\s+rental\s+real\s+estate", r"\bbox\s*2\b"], "amount"),
        ("other_rental_box3",    "Box 3",  "Other Net Rental Income (Loss)",
         [r"other\s+net\s+rental", r"\bbox\s*3\b"], "amount"),
        ("guaranteed_box4",      "Box 4",  "Guaranteed Payments for Services",
         [r"guaranteed\s+payments", r"\bbox\s*4\b"], "amount"),
        ("interest_box5",        "Box 5",  "Interest Income",
         [r"interest\s+income", r"\bbox\s*5\b"], "amount"),
        ("ordinary_div_box6a",   "Box 6a", "Ordinary Dividends",
         [r"ordinary\s+dividends?", r"\bbox\s*6a\b"], "amount"),
        ("qualified_div_box6b",  "Box 6b", "Qualified Dividends",
         [r"qualified\s+dividends?", r"\bbox\s*6b\b"], "amount"),
        ("royalties_box7",       "Box 7",  "Royalties",
         [r"\broyalties\b", r"\bbox\s*7\b"], "amount"),
        ("cap_gain_box9a",       "Box 9a", "Net Long-Term Capital Gain (Loss)",
         [r"long.term\s+capital\s+gain", r"\bbox\s*9a\b"], "amount"),
        ("self_employ_box14",    "Box 14", "Self-Employment Earnings (Loss)",
         [r"self.employment\s+earnings", r"\bbox\s*14\b"], "amount"),
    ],
    "W-9": [
        ("business_name", None, "Business Name/Disregarded Entity",
         [r"business\s+name", r"disregarded\s+entity"], "long_text"),
        ("federal_tax_classification", None, "Federal Tax Classification",
         [r"individual/sole\s+proprietor", r"c\s+corporation", r"s\s+corporation", r"partnership", r"trust/estate", r"limited\s+liability\s+company"], "long_text"),
    ],
    "OTHER": [],
}

# ─── Entity label patterns per form ────────────────────────────────────────
_PAYER_LABELS: Dict[str, List[str]] = {
    "W-2":      [r"employer.s\s+name", r"employer\s+name"],
    "1099-NEC": [r"payer.s\s+name", r"payer\s+name"],
    "1099-MISC":[r"payer.s\s+name", r"payer\s+name"],
    "1099-INT": [r"payer.s\s+name", r"financial\s+institution"],
    "1099-DIV": [r"payer.s\s+name"],
    "1099-R":   [r"payer.s\s+name", r"plan\s+name"],
    "1098":     [r"lender.s\s+name", r"recipient.s\s+name"],
    "1040":     [],
    "K-1":      [r"partnership.s\s+name", r"corporation.s\s+name", r"entity.s\s+name"],
    "W-9":      [],
    "OTHER":    [r"payer.s\s+name"],
}
_RECIP_LABELS: Dict[str, List[str]] = {
    "W-2":      [r"employee.s\s+(?:first\s+)?name", r"employee\s+name"],
    "1099-NEC": [r"recipient.s\s+name"],
    "1099-MISC":[r"recipient.s\s+name"],
    "1099-INT": [r"recipient.s\s+name", r"account\s+holder"],
    "1099-DIV": [r"recipient.s\s+name"],
    "1099-R":   [r"recipient.s\s+name"],
    "1098":     [r"borrower.s\s+name", r"payer.s\s+name"],
    "1040":     [r"your\s+first\s+name", r"taxpayer"],
    "K-1":      [r"partner.s\s+name", r"shareholder.s\s+name", r"beneficiary.s\s+name"],
    "W-9":      [r"name\s*\(as\s*shown\s*on\s*your\s*income\s*tax\s*return\)"],
    "OTHER":    [r"recipient.s\s+name"],
}



# ─── Multi-column layout handling ──────────────────────────────────────────
# Many payroll-generated statements (e.g. ADP W-2s) place the actual form
# grid in one column and an explanatory "Earnings Summary" in a second
# column alongside it — and often repeat several small form copies
# side-by-side further down the same page. pdfplumber's layout=True mode
# reconstructs lines by row position only, so it happily splices unrelated
# column content onto the same output line as a box label — e.g. "c
# Employer's name, address, and zip code" ends up followed by "Gross Pay
# 6,264.81 ..." from the other column. That corrupts every "value follows
# label" lookup. To avoid this, the page is split hierarchically:
#   1. Horizontal bands, using blank vertical gaps that span the full page
#      width (separates e.g. the top annotated copy from a row of repeated
#      mini copies below it — regions with genuinely different column
#      layouts).
#   2. Within each band, vertical columns, using blank gaps that span that
#      band's height (separates the form grid from the side annotation, or
#      splits several side-by-side mini copies).
# Each resulting region is extracted independently and concatenated in
# reading order (band by band, left column to right within a band), so
# unrelated regions never merge onto the same text line.
_MIN_GUTTER_PTS = 12
_MARGIN_FRAC = 0.03
_MIN_REGION_WORDS = 5


def _find_gaps(occupied: List[bool], lo: int, hi: int, bucket: float, min_gap_pts: float) -> List[Tuple[float, float]]:
    """Return (start, end) ranges (in points) of blank runs within [lo, hi)."""
    gaps = []
    run_start = None
    for b in range(lo, hi):
        if not occupied[b]:
            if run_start is None:
                run_start = b
        elif run_start is not None:
            gaps.append((run_start, b))
            run_start = None
    if run_start is not None:
        gaps.append((run_start, hi))
    return [(s * bucket, e * bucket) for s, e in gaps if (e - s) * bucket >= min_gap_pts]


def _find_row_bands(words: list, page_height: float) -> List[Tuple[float, float]]:
    """Split a page's words into horizontal bands separated by full-width
    blank vertical gaps."""
    full = [(0.0, page_height)]
    if len(words) < _MIN_REGION_WORDS * 2:
        return full

    bucket = 2.0
    n_buckets = int(page_height // bucket) + 1
    occupied = [False] * n_buckets
    for w in words:
        b0 = max(0, int(w["top"] // bucket))
        b1 = min(n_buckets - 1, int(w["bottom"] // bucket))
        for b in range(b0, b1 + 1):
            occupied[b] = True

    real_gaps = _find_gaps(occupied, 0, n_buckets, bucket, _MIN_GUTTER_PTS)
    if not real_gaps:
        return full

    bounds = [0.0] + [(s + e) / 2 for s, e in real_gaps] + [page_height]
    bands = []
    for i in range(len(bounds) - 1):
        y0, y1 = bounds[i], bounds[i + 1]
        band_word_count = sum(1 for w in words if w["top"] >= y0 - 1 and w["bottom"] <= y1 + 1)
        if band_word_count >= _MIN_REGION_WORDS:
            bands.append((y0, y1))

    return bands if bands else full


def _find_column_bboxes(words: list, page_width: float) -> List[Tuple[float, float]]:
    """Split a set of words (already scoped to one horizontal band) into
    vertical columns separated by blank gaps."""
    full = [(0.0, page_width)]
    if len(words) < _MIN_REGION_WORDS * 2:
        return full

    bucket = 2.0
    n_buckets = int(page_width // bucket) + 1
    occupied = [False] * n_buckets
    for w in words:
        b0 = max(0, int(w["x0"] // bucket))
        b1 = min(n_buckets - 1, int(w["x1"] // bucket))
        for b in range(b0, b1 + 1):
            occupied[b] = True

    lo = int(page_width * _MARGIN_FRAC // bucket)
    hi = int(page_width * (1 - _MARGIN_FRAC) // bucket)
    real_gaps = _find_gaps(occupied, lo, hi, bucket, _MIN_GUTTER_PTS)
    if not real_gaps:
        return full

    bounds = [0.0] + [(s + e) / 2 for s, e in real_gaps] + [page_width]
    columns = []
    for i in range(len(bounds) - 1):
        x0, x1 = bounds[i], bounds[i + 1]
        col_word_count = sum(1 for w in words if w["x0"] >= x0 - 1 and w["x1"] <= x1 + 1)
        if col_word_count >= _MIN_REGION_WORDS:
            columns.append((x0, x1))

    return columns if len(columns) >= 2 else full


def _extract_page_text(page) -> Tuple[str, List[str]]:
    """Extract a page's text region-by-region (top-to-bottom bands, then
    left-to-right columns within each band) so that unrelated side-by-side
    or stacked content never lands on the same output line."""
    words = page.extract_words()
    if not words:
        text = page.extract_text(layout=True) or page.extract_text() or ""
        return text, [text]

    region_texts = []
    for y0, y1 in _find_row_bands(words, page.height):
        band_words = [w for w in words if w["top"] >= y0 - 1 and w["bottom"] <= y1 + 1]
        for x0, x1 in _find_column_bboxes(band_words, page.width):
            region = page.crop((x0, y0, x1, y1))
            try:
                region_text = region.extract_text(layout=True) or ""
            except TypeError:
                region_text = region.extract_text() or ""
            if region_text:
                region_texts.append(region_text)

    return "\n".join(region_texts), region_texts


# ─── Text extraction ───────────────────────────────────────────────────────
def _extract_from_pdf(file_bytes: bytes) -> Tuple[str, bool]:
    """
    Extract text from a PDF using pdfplumber.
    Returns (text, is_digital) — is_digital=False suggests a scanned document.
    """
    pages_text: List[str] = []

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            text, _ = _extract_page_text(page)

            if not text:
                text = page.extract_text() or ""

            pages_text.append(text)

            # Also append table data as pipe-separated rows
            for table in page.extract_tables() or []:
                for row in table:
                    cells = [str(c).strip() for c in (row or []) if c]
                    if cells:
                        pages_text.append("  |  ".join(cells))

    combined = "\n".join(pages_text)
    # Heuristic: if average chars per page < 80, it's likely scanned
    is_digital = len(combined.strip()) > max(page_count, 1) * 80
    return combined, is_digital



# ─── Form detection ────────────────────────────────────────────────────────
def _detect_form_type(text: str) -> str:
    """Score keyword signatures to identify the IRS form type."""
    text_lower = text.lower()
    scores: Counter = Counter()
    for form_type, sigs in FORM_SIGNATURES.items():
        for sig in sigs:
            if sig in text_lower:
                scores[form_type] += 1
    if not scores:
        return "OTHER"
    best, score = scores.most_common(1)[0]
    return best if score >= 1 else "OTHER"


def _extract_tax_year(text: str) -> Optional[str]:
    """Return the most frequently occurring calendar year in the text."""
    years = YEAR_RE.findall(text)
    return Counter(years).most_common(1)[0][0] if years else None


# ─── Entity extraction ─────────────────────────────────────────────────────
def _mask_ssn(raw: str) -> str:
    parts = raw.split("-")
    return f"XXX-XX-{parts[2]}" if len(parts) == 3 else "XXX-XX-XXXX"


def _clean_entity_line(line: str) -> str:
    """Remove extraneous form labels, stray numbers, and amounts from an extracted name/address line."""
    patterns_to_remove = [
        r"\b(?:Medicare|Social security)\s*(?:wages|tax).*",
        r"\bAllocated\s+tips.*",
        r"\bDependent\s+care.*",
        r"\bNonqualified\s+plans.*",
        r"\bState\s+(?:wages|income).*",
        r"\bLocal\s+(?:wages|income).*",
        r"\b(?:Control|Box|Line)\s*(?:number)?\s*\d+[a-z]?\b.*",
        r"\bOther\s+\d+[a-z]?\b.*",
        r"\bSuff\.\s*\d+.*",
        r"\b(?:e\s*)?S\s*m\s*t\s*a.*",  # OCR garbage for Statutory employee etc.
        r"\bretirement\s+plan.*",
        r"\bthird-party\s+sick\s+pay.*",
        r"\b(?:statutory|employee).*?",
    ]
    cleaned = line
    for pat in patterns_to_remove:
        cleaned = re.sub(pat, "", cleaned, flags=re.IGNORECASE).strip()
    
    # Remove trailing amounts (e.g., 1273.51)
    while True:
        # Match AMOUNT_RE pattern at the end of the string
        m = re.search(r"\s+(?<![.\d\-])\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+\.\d{1,2}|\d{3,})(?![\-]\d)\b$", cleaned)
        if m:
            cleaned = cleaned[:m.start()].strip()
        else:
            break
            
    # Remove trailing stray digits (often box numbers)
    cleaned = re.sub(r"(?:\s+\d{1,2})+$", "", cleaned).strip()
    return cleaned

def _name_after_label(text: str, patterns: List[str]) -> Optional[str]:
    """Find the entity name that appears after a label keyword in the text."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        for pattern in patterns:
            m = re.search(pattern, line, re.IGNORECASE)
            if not m:
                continue
            # Try text on same line after the match
            after = line[m.end():].strip(" :,")
            if after and len(after) >= 3 and not AMOUNT_RE.search(after) and not EIN_RE.search(after):
                # Skip if this looks like another label instead of an actual name
                if not _LABEL_CONTINUATION_RE.search(after):
                    cleaned_after = _clean_entity_line(after)
                    if cleaned_after:
                        return cleaned_after
            # Try next 1–3 lines
            for j in range(1, 4):
                if i + j >= len(lines):
                    break
                cand = lines[i + j].strip()
                if not cand or len(cand) < 3:
                    continue
                # Skip lines that look like EINs, SSNs, all-numbers, or blank
                if EIN_RE.search(cand) or SSN_RE.search(cand):
                    continue
                if re.fullmatch(r"[\d\s,$.\-]+", cand):
                    continue
                # Skip lines that are clearly another form label
                if re.search(r"\bbox\s*\d|\bline\s*\d", cand, re.IGNORECASE):
                    continue
                
                cleaned_cand = _clean_entity_line(cand)
                if cleaned_cand and len(cleaned_cand) >= 3:
                    return cleaned_cand
    return None


def _address_after_label(text: str, patterns: List[str]) -> Optional[str]:
    """Find the entity address by looking at lines following the name."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        for pattern in patterns:
            if re.search(pattern, line, re.IGNORECASE):
                # Check next few lines for something that looks like an address (e.g. contains a zip code)
                addr_lines = []
                for j in range(1, 6):
                    if i + j >= len(lines):
                        break
                    cand = lines[i + j].strip()
                    if not cand or len(cand) < 3:
                        continue
                    if EIN_RE.search(cand) or SSN_RE.search(cand):
                        continue
                    if re.fullmatch(r"[\d\s,$.\-]+", cand):
                        continue
                    if re.search(r"\bbox\s*\d|\bline\s*\d", cand, re.IGNORECASE):
                        continue
                        
                    # Zip code heuristics (5 digits or 5-4 digits, usually preceded by state
                    # abbr) — checked against the RAW candidate line, since _clean_entity_line's
                    # trailing-amount stripper would otherwise delete the zip digits themselves
                    # before this check ever sees them.
                    has_zip = bool(re.search(r"\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b", cand, re.IGNORECASE))
                    cleaned_cand = cand if has_zip else _clean_entity_line(cand)
                    if cleaned_cand:
                        addr_lines.append(cleaned_cand)
                    if has_zip:
                        # Filter out the name if it got caught in the address lines
                        # The first line is usually the name, so we can drop it if it doesn't look like an address part
                        if len(addr_lines) > 1 and not re.search(r"\d+", addr_lines[0]):
                            addr_lines = addr_lines[1:]
                        return ", ".join(addr_lines)
    return None

def _extract_entities(text: str, form_type: str) -> Tuple[dict, dict]:
    """Return (payer, recipient) dicts with name/ein/tin info."""
    payer_name = _name_after_label(text, _PAYER_LABELS.get(form_type, []))
    recip_name = _name_after_label(text, _RECIP_LABELS.get(form_type, []))
    
    payer_address = _address_after_label(text, _PAYER_LABELS.get(form_type, []))
    recip_address = _address_after_label(text, _RECIP_LABELS.get(form_type, []))

    ein_m = EIN_RE.search(text)
    ein   = ein_m.group(1) if ein_m else None

    ssn_m = SSN_RE.search(text)
    tin   = _mask_ssn(ssn_m.group(0)) if ssn_m else None
    
    # 1040 spouse handling
    if form_type == "1040":
        spouse_name = _name_after_label(text, [r"spouse.s\s+first\s+name"])
        if spouse_name:
            recip_name = f"{recip_name} & {spouse_name}" if recip_name else spouse_name

    return (
        {"name": payer_name, "ein": ein,  "address": payer_address},
        {"name": recip_name, "tin": tin,  "address": recip_address},
    )


# ─── Field value extraction ────────────────────────────────────────────────
def _parse_amount(raw: str) -> Optional[str]:
    """Format a raw number string as a dollar amount, or return None if zero/invalid."""
    try:
        val = float(raw.replace(",", "").strip("$").strip())
        return f"${val:,.2f}" if val != 0.0 else None
    except ValueError:
        return None


def _valid_amounts(raw_list: List[str]) -> List[str]:
    """
    Parse a list of raw amount strings, returning only formatted values >= $1.00.
    Values below $1.00 are almost certainly noise (stray digits, box separators, etc.).
    """
    results = []
    for raw in raw_list:
        parsed = _parse_amount(raw)
        if parsed:
            try:
                if float(parsed.replace("$", "").replace(",", "")) >= 1.0:
                    results.append(parsed)
            except ValueError:
                pass
    return results


def _max_amount(amounts: List[str]) -> str:
    """Return the largest dollar amount from a list of formatted strings like '$1,234.56'."""
    return max(amounts, key=lambda x: float(x.replace("$", "").replace(",", "")))


def _label_ordinal_on_line(line: str, all_patterns: List[str], label_start: int) -> Tuple[int, int]:
    """
    Return (ordinal, total) describing this label's position among ALL box
    labels recognised on the same line. Space-aligned form grids often put
    two or more box labels on one row (e.g. "3 Social security wages   4
    Social security tax withheld"), with their values on the row below in
    the same left-to-right order. Position-based x-slicing is fragile here
    because value spacing rarely lines up with label spacing — ordinal
    (1st label -> 1st value, 2nd label -> 2nd value) is far more reliable.
    """
    starts = set()
    for pat in all_patterns:
        for m in re.finditer(pat, line, re.IGNORECASE):
            starts.add(m.start())
    ordered = sorted(starts)
    ordinal = ordered.index(label_start) if label_start in ordered else 0
    return ordinal, len(ordered)


def _find_value(
    lines: List[str],
    patterns: List[str],
    value_type: str = "amount",
    window: int = 6,
    all_patterns: Optional[List[str]] = None,
) -> Tuple[Optional[str], str, Optional[str]]:
    """
    Search `lines` for any of `patterns`, then locate the associated value.

    Strategy:
      1. If a value appears on the SAME line AFTER the label — high confidence.
      2. If a value appears within `window` subsequent lines — medium confidence.
         For pipe-separated table rows, only the same column as the label is searched
         (prevents cross-column bleed when multiple boxes share a data row).
         For space-aligned rows with multiple box labels, values are matched by
         left-to-right ordinal position rather than x-coordinate.
      3. If nothing found — low confidence, null value.

    Returns (value, confidence, note).

    A label phrase can legitimately appear more than once in a document —
    e.g. a form's title/heading ("Nonemployee Compensation") often repeats
    the exact wording of a box label ("1 Nonemployee compensation") lower
    down. Committing to whichever occurrence is found first is unsafe: if
    that first hit is the heading, searching its neighbourhood for a value
    can latch onto unrelated nearby numbers (an address digit, etc). So
    every matching occurrence in the document is examined, and the best
    (highest-confidence) result wins rather than the first-found one.
    """
    n = len(lines)
    all_patterns = all_patterns or patterns
    best: Optional[Tuple[str, str, Optional[str]]] = None
    label_found_anywhere = False
    _CONF_RANK = {"high": 2, "medium": 1}

    for i, line in enumerate(lines):
        for pattern in patterns:
            label_match = re.search(pattern, line, re.IGNORECASE)
            if not label_match:
                continue
            label_found_anywhere = True

            # Detect pipe-separated table rows and locate the label's column index.
            # pdfplumber appends table rows as "cell1  |  cell2  |  cell3" strings.
            # Knowing the column lets us restrict value lookup to the correct column
            # in subsequent rows, preventing cross-column bleed (e.g. state tax vs.
            # state wages sharing the same data line).
            label_col_idx = -1
            if " | " in line or "  |  " in line:
                label_cells = _TABLE_SEP_RE.split(line)
                for ci, cell in enumerate(label_cells):
                    if re.search(pattern, cell, re.IGNORECASE):
                        label_col_idx = ci
                        break

            def _record(value, conf, note):
                """Track the best candidate seen so far; return True once a
                high-confidence hit is found (nothing can beat it, so the
                caller should stop scanning)."""
                nonlocal best
                if value is None:
                    return False
                if best is None or _CONF_RANK.get(conf, 0) > _CONF_RANK.get(best[1], 0):
                    best = (value, conf, note)
                return conf == "high"

            label_ordinal, label_row_total = _label_ordinal_on_line(
                line, all_patterns, label_match.start()
            )

            # ── Strategy 1: value on same line, after label ────────────
            # Keep the full untruncated tail for regex matching — patterns
            # like AMOUNT_RE rely on lookahead context (e.g. a bare "2"
            # followed by "Federal..." must NOT match as an amount) that a
            # hard string cut would destroy. Instead, when another label
            # shares this row, filter matches by position so nothing past
            # the next label's start is treated as this field's value.
            after_full = line[label_match.end():]
            next_boundary = None
            if label_row_total > 1:
                next_starts = [s for s in
                               (m.start() for pat in all_patterns
                                for m in re.finditer(pat, line, re.IGNORECASE))
                               if s > label_match.start()]
                if next_starts:
                    next_boundary = min(next_starts) - label_match.end()

            if value_type == "amount":
                raw_matches = [m.group(1) for m in AMOUNT_RE.finditer(after_full)
                               if next_boundary is None or m.start() < next_boundary]
                hits = _valid_amounts(raw_matches)
                if hits:
                    # Prefer the largest value — box-label numbers nearby are smaller
                    if _record(_max_amount(hits), "high", None):
                        return best
            elif value_type == "date":
                dm = DATE_RE.search(after_full)
                if dm and (next_boundary is None or dm.start() < next_boundary):
                    if _record(dm.group(1), "high", None):
                        return best
            elif value_type == "long_text":
                after = (after_full[:next_boundary] if next_boundary is not None else after_full).strip(" :,")
                if after and not _LABEL_CONTINUATION_RE.search(after):
                    if _record(after, "high", None):
                        return best
            elif value_type in ("code", "text"):
                cm = re.search(r"\b([A-Z0-9]{1,4})\b", after_full)
                if cm and (next_boundary is None or cm.start() < next_boundary):
                    if _record(cm.group(1), "high", None):
                        return best

            # ── Strategy 2: value on subsequent lines ──────────────────
            for j in range(1, window):
                if i + j >= n:
                    break
                sl = lines[i + j]
                conf = "high"  if j <= 2 else "medium"
                note = None    if j <= 2 else "Value found several lines below label — verify"

                if value_type == "amount":
                    # ── Column-aware path for pipe-separated table rows ──
                    if label_col_idx >= 0 and (" | " in sl or "  |  " in sl):
                        sl_cells = _TABLE_SEP_RE.split(sl)
                        if label_col_idx < len(sl_cells):
                            cell_text = sl_cells[label_col_idx]
                            hits = _valid_amounts(AMOUNT_RE.findall(cell_text))
                            if hits and _record(_max_amount(hits), conf, note):
                                return best
                        # Column exists but is empty — skip whole-line fallback to
                        # avoid picking up a value from a neighbouring column.
                        continue

                    # ── Positional constraint for space-aligned text ──
                    if label_col_idx >= 0:
                        continue  # Skip if label was pipe-separated but this line is not

                    # ── Ordinal-aware path for space-aligned multi-box rows ──
                    # When several box labels share the label line (common in
                    # W-2/1099 grids), match this label's rank to the value at
                    # the same rank on the candidate line, rather than trusting
                    # x-position alignment between the two rows.
                    if label_row_total > 1:
                        row_hits = _valid_amounts(AMOUNT_RE.findall(sl))
                        if len(row_hits) == label_row_total:
                            if _record(row_hits[label_ordinal], conf, note):
                                return best
                            continue

                # Non-amount types (and amount as a final fallback) look at a
                # slice of the candidate line positioned near the label's own
                # column, rather than the whole line.
                slice_start = max(0, label_match.start() - 20)
                slice_start = min(slice_start, len(sl))
                # Expand left to avoid cutting numbers/words in half
                while slice_start > 0 and sl[slice_start - 1] not in (' ', '\t', '|'):
                    slice_start -= 1

                slice_end = slice_start + 70
                # Expand right as well
                while slice_end < len(sl) and sl[slice_end] not in (' ', '\t', '|'):
                    slice_end += 1

                sl_slice = sl[slice_start:slice_end]

                if value_type == "amount":
                    hits = _valid_amounts(AMOUNT_RE.findall(sl_slice))
                    if hits and _record(_max_amount(hits), conf, note):
                        return best
                elif value_type == "date":
                    dm = DATE_RE.search(sl_slice)
                    if dm and _record(dm.group(1), conf, None):
                        return best
                elif value_type == "long_text":
                    sl_stripped = sl_slice.strip()
                    if sl_stripped and not _LABEL_CONTINUATION_RE.search(sl_stripped):
                        if _record(sl_stripped, conf, None):
                            return best
                elif value_type in ("code", "text"):
                    cm = re.search(r"\b([A-Z0-9]{1,4})\b", sl_slice)
                    if cm and _record(cm.group(1), conf, None):
                        return best

            # Label matched on this line but no value found in its window —
            # keep scanning; a later occurrence of the label may fare better.

    if best is not None:
        return best
    if label_found_anywhere:
        return None, "low", "Label detected but value not found in document"
    return None, "low", "Field label not found in document"


# Box-level fields whose value is really just the payer/recipient entity
# already resolved by _extract_entities. That function collects the
# multi-line name/address block correctly (zip-code detection, EIN/SSN
# exclusion); re-deriving it here via generic single-line label matching
# tends to capture leftover label text instead (e.g. box c's label reads
# "Employer's name, address, and zip code" — the same-line text after
# "Employer's name" is just the rest of the label, not a value).
_ENTITY_FIELD_MAP = {
    "employer_name":    ("payer", "name"),
    "employer_address": ("payer", "address"),
    "employee_name":    ("recip", "name"),
    "employee_address": ("recip", "address"),
}


def _extract_fields(text: str, form_type: str, is_digital: bool, payer: dict, recip: dict) -> List[dict]:
    """Extract all expected fields for this form type."""
    field_defs = FORM_FIELDS.get(form_type, [])
    if not field_defs:
        return []

    lines = [ln for ln in text.split("\n")]  # preserve spacing for column alignment
    results = []

    all_patterns = [p for (_, _, _, pats, _) in field_defs for p in pats]
    entities = {"payer": payer, "recip": recip}

    for field_id, box, label, patterns, value_type in field_defs:
        if field_id in _ENTITY_FIELD_MAP:
            entity_key, attr = _ENTITY_FIELD_MAP[field_id]
            value = entities[entity_key].get(attr)
            conf = "high" if value else "low"
            note = None if value else "Field label not found in document"
        else:
            value, conf, note = _find_value(lines, patterns, value_type, all_patterns=all_patterns)

        results.append({
            "id":         field_id,
            "box":        box,
            "label":      label,
            "value":      value,
            "confidence": conf,
            "note":       note,
        })

    return results


# ─── Public entry point ────────────────────────────────────────────────────
def extract_document(file_bytes: bytes, content_type: str) -> dict:
    """
    Extract structured tax data from a document.

    Args:
        file_bytes:   Raw bytes of the uploaded file.
        content_type: MIME type — "application/pdf" or "image/*".

    Returns:
        Structured dict matching the TaxExtract JSON schema.

    Raises:
        RuntimeError: If text extraction fails or Tesseract is missing for images.
    """
    is_digital = True

    if content_type != "application/pdf":
        raise RuntimeError("Only PDF documents are supported for text extraction.")

    text, is_digital = _extract_from_pdf(file_bytes)

    if not text.strip():
        raise RuntimeError("No text could be extracted from this PDF document.")

    logger.info(
        "Extraction — content_type=%s chars=%d is_digital=%s",
        content_type, len(text), is_digital,
    )

    # ── Analysis ───────────────────────────────────────────────────────────
    form_type   = _detect_form_type(text)
    tax_year    = _extract_tax_year(text)
    payer, recip = _extract_entities(text, form_type)
    fields      = _extract_fields(text, form_type, is_digital, payer, recip)

    logger.info("form_type=%s tax_year=%s fields=%d", form_type, tax_year, len(fields))

    return {
        "formType":        form_type,
        "formDescription": FORM_DESCRIPTIONS.get(form_type, "Tax Document"),
        "taxYear":         tax_year,
        "payer":           payer,
        "recipient":       recip,
        "fields":          fields,
    }
