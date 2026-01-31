
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

      // Budget context fields (from VarianceSummary lookup)
      BudgetAmount,
      ActualToDate,
      VarianceAmount,
      VariancePct,
      AllowedVariancePct,
      Status,
      Headroom,

      // Optional: if later you add this in Zapier
      HeadroomCandidates,   // can be text or JSON string
      StrategyOverride      // optional text override
    } = body;

    // Basic validation
    if (!Division || !Category || Amount === undefined || Amount === null || Amount === "") {
      return res.status(400).json({
        error: "Missing required fields: Division, Category, Amount"
      });
    }

    // Helper: safe number parsing (Zapier often sends strings)
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const expense = {
      Division,
      Category,
      VendorSource: VendorSource || "",
      Amount: num(Amount),
      Notes: Notes || ""
    };

    const context = {
      BudgetAmount: num(BudgetAmount),
      ActualToDate: num(ActualToDate),
      VarianceAmount: num(VarianceAmount),
      VariancePct: num(VariancePct),
      AllowedVariancePct: num(AllowedVariancePct),
      Status: (Status || "").toUpperCase(),
      Headroom: num(Headroom)
    };

    // ---- 2) Build a clean VarianceSummary string for DecisionLog ----
    const varianceSummaryText = [
      `Budget: ${context.BudgetAmount ?? "n/a"}`,
      `ActualToDate: ${context.ActualToDate ?? "n/a"}`,
      `VarianceAmount: ${context.VarianceAmount ?? "n/a"}`,
      `VariancePct: ${context.VariancePct ?? "n/a"}`,
      `Allowed: ${context.AllowedVariancePct ?? "n/a"}`,
      `Status: ${context.Status || "n/a"}`,
      `Headroom: ${context.Headroom ?? "n/a"}`
    ].join(" | ");

    // ---- 3) Corporate strategy prompt (EDIT THIS ONCE, use forever) ----
    // You can also put this into a Vercel env var CORPORATE_STRATEGY_PROMPT if you prefer.
    const DEFAULT_CORPORATE_STRATEGY = `
Corporate Strategy for Resource Allocation (Ground Truth):
- Protect "keep-the-lights-on" and risk-critical spending:
  - Payroll and Benefits are mission-critical: avoid cutting unless extreme. If OVER, prefer budget increase or reallocation from non-critical areas.
  - Security & Compliance is risk-critical: do not cut below minimum; if OVER, justify increase or reallocate from lower priority areas.
- Prioritize growth and product differentiation:
  - R&D Investment is strategically important: if OVER, prefer reallocation or budget increase if it supports roadmap milestones.
  - Cloud Compute & Storage should be optimized: if OVER, first recommend cost optimization (rightsizing/reservations), then reallocate, then increase budget if usage is tied to growth.
- Revenue acceleration and go-to-market efficiency:
  - Advertising/Events can be tuned quickly: if OVER, prefer cut costs (reduce spend) unless strong ROI evidence is noted.
  - Professional Services is delivery capacity: if OVER, prefer reallocate or increase budget if tied to committed client delivery.
- Data tooling:
  - Market Data/Analytics Subscriptions should be rationalized: if OVER, prefer cut costs (remove unused seats/tools) or reallocate if essential for product goals.

General rules:
- If Status is OK: approve (no action needed).
- If Status is WATCH: flag + preventative suggestion (only recommend reallocation if it prevents near-term OVER).
- If Status is OVER: pick the best action using the strategy above:
  - "cut costs" if category is discretionary/tunable (e.g., Advertising/Events, some subscriptions)
  - "increase budget" if category is mission-critical or ROI-justified (Payroll/Benefits/Security or R&D milestone)
  - "reallocate budget" if there is known headroom elsewhere or if shifting aligns with strategy priorities
`;

    const corporateStrategy =
      (process.env.CORPORATE_STRATEGY_PROMPT && process.env.CORPORATE_STRATEGY_PROMPT.trim()) ||
      (StrategyOverride && String(StrategyOverride).trim()) ||
      DEFAULT_CORPORATE_STRATEGY;

    // Optional headroom candidates (not required today; safe to ignore if missing)
    let headroomCandidatesParsed = null;
    if (HeadroomCandidates) {
      try {
        headroomCandidatesParsed =
          typeof HeadroomCandidates === "string" ? JSON.parse(HeadroomCandidates) : HeadroomCandidates;
      } catch {
        headroomCandidatesParsed = String(HeadroomCandidates);
      }
    }

    // ---- 4) Map AllowedVariancePct to tolerance label ----
    const toleranceFromAllowed = (allowed) => {
      if (allowed === 0.05) return "strict";
      if (allowed === 0.1) return "moderate";
      if (allowed === 0.2) return "loose";
      return "moderate";
    };
    const defaultTolerance = toleranceFromAllowed(context.AllowedVariancePct);

    // ---- 5) Hard guardrail: if OK, always approve (saves time + makes sense) ----
    if (context.Status === "OK") {
      const out = {
        VarianceSummary: varianceSummaryText,
        AITolerance: defaultTolerance,
        AIAction: "approve",
        ExpectedImpact: "No action needed; within budget guardrails. Saves review time by auto-approving.",
        // Back-compat (won't hurt)
        summary: varianceSummaryText,
        tolerance: defaultTolerance,
        recommendation: "approve"
      };
      return res.status(200).json(out);
    }

    // ---- 6) Call OpenAI for WATCH/OVER (where strategy matters) ----
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }

    // We keep allowed actions limited so output is reliable for Zapier + demo.
    const userPrompt =
      `You are an AI finance assistant. Use the corporate strategy below as ground truth.\n` +
      `Return JSON ONLY with EXACT keys: VarianceSummary, AITolerance, AIAction, ExpectedImpact.\n\n` +

      `AIAction must be exactly one of: "approve", "flag", "cut costs", "reallocate budget", "increase budget".\n` +
      `AITolerance must be one of: strict, moderate, loose.\n\n` +

      `Expense:\n${JSON.stringify(expense)}\n\n` +
      `BudgetContext:\n${varianceSummaryText}\n\n` +
      (headroomCandidatesParsed
        ? `Optional headroom candidates to support reallocation (if provided):\n${JSON.stringify(headroomCandidatesParsed)}\n\n`
        : "") +

      `Corporate Strategy (ground truth):\n${corporateStrategy}\n\n` +

      `Decision guidance:\n` +
      `- If Status is WATCH: set AIAction to "flag" unless a reallocation is clearly warranted to prevent OVER.\n` +
      `- If Status is OVER: choose between "cut costs", "reallocate budget", "increase budget" using the strategy.\n` +
      `- Always set VarianceSummary to the BudgetContext string you were given (you may append 1 short sentence if useful).\n` +
      `- ExpectedImpact: 1 short sentence (time saved, risk reduced, or performance improved).\n`;

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

    // ---- 7) Parse + validate (so Zapier doesn’t break) ----
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const aiActionAllowed = new Set(["approve", "flag", "cut costs", "reallocate budget", "increase budget"]);
    const tolAllowed = new Set(["strict", "moderate", "loose"]);

    // Deterministic fallback for reliability
    const fallbackAction = () => {
      if (context.Status === "WATCH") return "flag";
      if (context.Status === "OVER") {
        // Default safe choice for OVER if we can't reason further
        return "reallocate budget";
      }
      return "flag";
    };

    const finalOut = {
      VarianceSummary: varianceSummaryText,
      AITolerance: defaultTolerance,
      AIAction: fallbackAction(),
      ExpectedImpact: "Automates variance review and provides consistent recommendations."
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

    // Backward-compatible keys (won't hurt your current Zap mappings)
    finalOut.summary = finalOut.VarianceSummary;
    finalOut.tolerance = finalOut.AITolerance;
    finalOut.recommendation = finalOut.AIAction;

    return res.status(200).json(finalOut);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}

