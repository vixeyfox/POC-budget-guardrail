
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const body = req.body || {};

    // ---- 1) Pull fields from Zapier flat payload ----
    const {
      // Expense fields
      Division,
      Category,
      VendorSource,
      Amount,
      Notes,

      // VarianceSummary fields from Google Sheets lookup
      BudgetAmount,
      ActualToDate,
      VarianceAmount,
      VariancePct,
      AllowedVariancePct,
      Status,
      Headroom,

      // Optional: if you ever add these later
      HeadroomCandidates,  // JSON string or plain text
      StrategyOverride     // optional custom strategy text passed from Zapier
    } = body;

    // Basic validation (keep minimal for MVP)
    if (!Division || !Category || Amount === undefined || Amount === null || Amount === "") {
      return res.status(400).json({
        error: "Missing required fields: Division, Category, Amount"
      });
    }

    // Helpers: safe number parsing
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const pct = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    // ---- 2) Normalize numbers (Zapier often sends strings) ----
    const budgetAmount = num(BudgetAmount);
    const actualToDate = num(ActualToDate);
    const varianceAmount = num(VarianceAmount);
    const variancePct = pct(VariancePct);
    const allowedPct = pct(AllowedVariancePct);
    const headroom = num(Headroom);

    // ---- 3) Determine Status (trust Google Sheets, but include fallback) ----
    // Your sheet formula is:
    // =IF(G2 > H2, "OVER", IF(G2 > 0, "WATCH", "OK"))
    // We'll use Status if provided, otherwise compute it from variancePct/allowedPct.
    let status = (Status || "").toUpperCase().trim();

    if (!status) {
      if (variancePct !== null && allowedPct !== null) {
        if (variancePct > allowedPct) status = "OVER";
        else if (variancePct > 0) status = "WATCH";
        else status = "OK";
      } else {
        status = "WATCH"; // safe default if missing data
      }
    }

    // ---- 4) Tolerance label (for your DecisionLog AITolerance column) ----
    const toleranceFromAllowed = (ap) => {
      if (ap === null) return "moderate";
      if (ap <= 0.05) return "strict";
      if (ap <= 0.1) return "moderate";
      return "loose";
    };
    const toleranceLabel = toleranceFromAllowed(allowedPct);

    // ---- 5) Build structured context objects (useful for prompting) ----
    const expense = {
      Division,
      Category,
      VendorSource: VendorSource || "",
      Amount: num(Amount),
      Notes: Notes || ""
    };

    // A clean VarianceSummary string for DecisionLog
    const varianceSummaryText = [
      `Budget: ${budgetAmount ?? "n/a"}`,
      `ActualToDate: ${actualToDate ?? "n/a"}`,
      `VarianceAmount: ${varianceAmount ?? "n/a"}`,
      `VariancePct: ${variancePct ?? "n/a"}`,
      `Allowed: ${allowedPct ?? "n/a"}`,
      `Status: ${status}`,
      `Headroom: ${headroom ?? "n/a"}`
    ].join(" | ");

    // Optional headroom candidates (future enhancement)
    let headroomCandidatesParsed = null;
    if (HeadroomCandidates) {
      try {
        headroomCandidatesParsed =
          typeof HeadroomCandidates === "string" ? JSON.parse(HeadroomCandidates) : HeadroomCandidates;
      } catch {
        headroomCandidatesParsed = String(HeadroomCandidates);
      }
    }

    // ---- 6) Corporate strategy prompt (edit this once, and you're done) ----
    const DEFAULT_CORPORATE_STRATEGY = `
Corporate Strategy for Resource Allocation (Ground Truth):
- Protect mission-critical and risk-critical spending:
  - Payroll and Benefits are mission-critical: avoid cutting unless extreme; 
  if OVER, prefer increase budget unless there is explicitly identified headroom in another G&A line.
  - Security & Compliance is risk-critical: do not cut below minimum; if OVER, justify increase or reallocate from lower priority areas.
- Prioritize product differentiation and growth:
  - R&D Investment is strategically important: if OVER, prefer reallocation or increase budget if tied to roadmap milestones.
  - Cloud Compute & Storage should be optimized: if OVER, recommend cost optimization (rightsizing/reservations),
  then reallocate, then increase budget if tied to growth.
- Revenue acceleration and delivery:
  - Advertising/Events is tunable: if OVER, prefer cut costs unless strong ROI evidence is noted.
  - Professional Services supports delivery: if OVER, reallocate or increase if tied to committed client obligations.
- Data tooling:
  - Market Data/Analytics subscriptions: if OVER, prefer cut costs (remove unused tools/seats) unless essential.

Status definitions:
- OK = under budget
- WATCH = over budget but within allowed variance
- OVER = over budget by greater than allowed variance
`;

    const corporateStrategy =
      (process.env.CORPORATE_STRATEGY_PROMPT && process.env.CORPORATE_STRATEGY_PROMPT.trim()) ||
      (StrategyOverride && String(StrategyOverride).trim()) ||
      DEFAULT_CORPORATE_STRATEGY;

    // ---- 7) Deterministic handling for OK and WATCH (fast, stable demo) ----
    if (status === "OK") {
      const out = {
        VarianceSummary: varianceSummaryText,
        AITolerance: toleranceLabel,
        AIAction: "approve",
        ExpectedImpact: "No action needed; within budget guardrails. Saves review time by auto-approving.",
        // backwards compatible keys
        summary: varianceSummaryText,
        tolerance: toleranceLabel,
        recommendation: "approve"
      };
      return res.status(200).json(out);
    }

    if (status === "WATCH") {
      const out = {
        VarianceSummary: varianceSummaryText,
        AITolerance: toleranceLabel,
        AIAction: "flag",
        ExpectedImpact: "Early warning before policy breach; prompts review and prevents reactive overspend.",
        summary: varianceSummaryText,
        tolerance: toleranceLabel,
        recommendation: "flag"
      };
      return res.status(200).json(out);
    }

    // ---- 8) OVER: call OpenAI to choose cut/reallocate/increase using strategy ----
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }

    const userPrompt =
      `You are an AI finance assistant. Use the corporate strategy below as ground truth.\n` +
      `We are currently OVER budget.\n\n` +
      `Return JSON ONLY with EXACT keys: VarianceSummary, AITolerance, AIAction, ExpectedImpact.\n` +
      `- AIAction must be exactly one of: "cut costs", "reallocate budget", "increase budget".\n` +
      `- AITolerance must be one of: strict, moderate, loose.\n\n` +
      `Expense:\n${JSON.stringify(expense)}\n\n` +
      `BudgetContext:\n${varianceSummaryText}\n\n` +
      (headroomCandidatesParsed
        ? `Optional headroom candidates (if provided):\n${JSON.stringify(headroomCandidatesParsed)}\n\n`
        : "") +
      `Corporate Strategy (ground truth):\n${corporateStrategy}\n\n` +
      `Instructions:\n` +
      `- Choose the best action using the strategy (not generic rules).\n` +
      `- VarianceSummary should start with the BudgetContext string exactly as given; you may append 1 short sentence.\n` +
      `- ExpectedImpact: 1 short sentence about risk reduction, delivery protection, or time saved.\n`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Return JSON only. No markdown. No extra keys." },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "OpenAI request failed",
        status: response.status,
        details: data
      });
    }

    const text = data?.choices?.[0]?.message?.content || "";

    // ---- 9) Parse + validate output (so Zapier never breaks) ----
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const aiActionAllowed = new Set(["cut costs", "reallocate budget", "increase budget"]);
    const tolAllowed = new Set(["strict", "moderate", "loose"]);

    // Fallback (safe default)
    const finalOut = {
      VarianceSummary: varianceSummaryText,
      AITolerance: toleranceLabel,
      AIAction: "reallocate budget",
      ExpectedImpact: "Reduces policy breach risk while maintaining priority work."
    };

    if (parsed && typeof parsed === "object") {
      if (typeof parsed.VarianceSummary === "string" && parsed.VarianceSummary.trim()) {
        finalOut.VarianceSummary = parsed.VarianceSummary;
      }
      if (typeof parsed.AITolerance === "string" && tolAllowed.has(parsed.AITolerance)) {
        finalOut.AITolerance = parsed.AITolerance;
      }
      if (typeof parsed.AIAction === "string" && aiActionAllowed.has(parsed.AIAction)) {
        finalOut.AIAction = parsed.AIAction;
      }
      if (typeof parsed.ExpectedImpact === "string" && parsed.ExpectedImpact.trim()) {
        finalOut.ExpectedImpact = parsed.ExpectedImpact;
      }
    }

    // backwards compatible keys
    finalOut.summary = finalOut.VarianceSummary;
    finalOut.tolerance = finalOut.AITolerance;
    finalOut.recommendation = finalOut.AIAction;

    return res.status(200).json(finalOut);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}

