Proof of Concept (POC) Budget Guardrail
AI-Enabled Budget Guardrails
A small proof‑of‑concept API that powers an AI‑assisted budget guardrails workflow.
It is designed to be called from automation tools (e.g., Zapier) with expense + budget context, then returns a structured recommendation that can be written into a Google Sheets decision log.
What this does (in plain language)
When an expense is submitted, this API:

Receives the expense details (division, category, vendor, amount, notes)
Receives budget context (budget, actual to date, variance %, allowed variance %, status, headroom)
Applies simple guardrail behavior:

OK (under budget) → returns approve <br><br>
WATCH (above budget, yet within tolerance threshold) → returns flag <br><br>
OVER (exceeds budget tolerance) → calls OpenAI and returns a strategy‑aware recommendation:<br>

cut costs, reallocate budget, or increase budget<br>

Returns JSON in a format that’s easy to map into a DecisionLog spreadsheet row.

Repo structure
.
├── api/ <br>
│   └── recommendation.js   # Serverless API endpoint called by Zapier <br>
└── package.json            # Minimal project metadata

Expected request (what to send from the Zapier form's Zap)
Send a POST request with a JSON body that includes:
Expense fields

Division
Category
VendorSource (optional)
Amount
Notes (optional)

Budget context fields (typically looked up from Google Sheets)

BudgetAmount
ActualToDate
VarianceAmount
VariancePct
AllowedVariancePct
Status (must be one of: OK, WATCH, OVER)
Headroom


Tip: In the full POC, Google Sheets computes Status using rules like:
OK = under budget, WATCH = over budget but within tolerance, OVER = beyond tolerance.

Response format (what you get back)
The API returns JSON with keys that are intended to map directly into a DecisionLog sheet:

VarianceSummary (string)
AITolerance (strict | moderate | loose)
AIAction (approve | flag | cut costs | reallocate budget | increase budget)
ExpectedImpact (short string)

It also returns backward‑compatible keys (useful if older Zap mappings exist):

summary, tolerance, recommendation

Environment variable required
Set the following environment variable in Vercel:

OPENAI_API_KEY — your OpenAI API key (required for OVER decisions)

Optional:

CORPORATE_STRATEGY_PROMPT — override the built‑in strategy guidance text

Deploying (recommended)
This project is meant to be deployed on Vercel as a serverless endpoint.

Push this repo to GitHub
Import the repo into Vercel
In Vercel → Settings → Environment Variables, add:

OPENAI_API_KEY


Deploy

Your endpoint will be available at:
https://<your-domain>.vercel.app/api/recommendation

Local testing (optional)
You can test by sending a POST request with JSON (using Postman, curl, etc.).
Example body:

{
  "Division": "Engineering",
  "Category": "Cloud Compute & Storage",
  "VendorSource": "Datadog",
  "Amount": 15000,
  "Notes": "Infra monitoring + APM",

  "BudgetAmount": 180000,
  "ActualToDate": 184750,
  "VarianceAmount": 4750,
  "VariancePct": 0.026,
  "AllowedVariancePct": 0.05,
  "Status": "WATCH",
  "Headroom": -4750
}
Typical workflow (how this is used in the full POC)
A common setup is:

Zapier Form → write to Google Sheets ActualExpenses
Google Sheets formulas update VarianceSummary
Zapier looks up the matching VarianceSummary row
Zapier sends expense + budget context to this API
API returns a recommendation
Zapier writes the recommendation to Google Sheets DecisionLog

Notes / limitations

This is a proof‑of‑concept: it’s built for clarity and demo‑ability, not production hardening.
It assumes the caller provides the correct budget context values (especially Status).
Production enhancements could include authentication, request validation, rate limiting, and richer reallocation logic.

