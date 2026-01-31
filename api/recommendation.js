
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const body = req.body || {};

    // Expense fields (from Zapier Form)
    const {
      Division,
      Category,
      VendorSource,
      Amount,
      Notes,

      // Budget context fields (from VarianceSummary lookup in Zapier)
      BudgetAmount,
      ActualToDate,
      VarianceAmount,
      VariancePct,
      AllowedVariancePct,
      Status,
      Headroom
    } = body;

    // Basic validation (keep minimal so it doesn't break tests)
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
      Status: Status || "",
      Headroom: num(Headroom)
    };

    // Build a VarianceSummary string for the DecisionLog column
    // (If some fields are missing, it still makes a readable summary.)
    const varianceSummaryText = [
      `Budget: ${context.BudgetAmount ?? "n/a"}`,
      `ActualToDate: ${context.ActualToDate ?? "n/a"}`,
      `VarianceAmount: ${context.VarianceAmount ?? "n/a"}`,
      `VariancePct: ${context.VariancePct ?? "n/a"}`,
      `Allowed: ${context.AllowedVariancePct ?? "n/a"}`,
      `Status: ${context.Status || "n/a"}`,
      `Headroom: ${context.Headroom ?? "n/a"}`
    ].join(" | ");

    // Map AllowedVariancePct to tolerance label
    const toleranceFromAllowed = (allowed) => {
      if (allowed === 0.05) return "strict";
      if (allowed === 0.1) return "moderate";
      if (allowed === 0.2) return "loose";
      return "moderate"; // sensible default
    };

    const defaultTolerance = toleranceFromAllowed(context.AllowedVariancePct);

    // Deterministic fallback action (so demo never breaks)
    const fallbackAction = () => {
      const status = (context.Status || "").toUpperCase();
      const headroom = context.Headroom;

      if (status === "OK") return "reallocate budget"; // you may prefer "reallocate budget" as default action wording
      if (status === "WATCH") return "reallocate budget";
      if (status === "OVER") {
        if (headroom !== null && headroom > 0) return "reallocate budget";
        return "cut costs";
      }
      // If status missing/unknown:
      return "reallocate budget";
    };

    // Call OpenAI
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }

    // IMPORTANT: We require keys compatible with DecisionLog
    const userPrompt =
      `You are an AI finance assistant. Return JSON ONLY.\n\n` +
      `New expense submitted:\n` +
      `Division: ${expense.Division}\n` +
      `Category: ${expense.Category}\n` +
      `VendorSource: ${expense.VendorSource}\n` +
      `Amount: ${expense.Amount}\n` +
      `Notes: ${expense.Notes}\n\n` +
      `Budget context (from VarianceSummary row):\n` +
      `${varianceSummaryText}\n\n` +
      `Return JSON ONLY with EXACT keys:\n` +
      `- VarianceSummary (string)\n` +
      `- AITolerance (strict|moderate|loose)\n` +
      `- AIAction (exactly one of: "cut costs", "reallocate budget", "increase budget")\n` +
      `- ExpectedImpact (short string, e.g. "reduces overage risk; saves review time")\n\n` +
      `Guidance:\n` +
      `- If Status is OVER and Headroom is positive, choose "reallocate budget"\n` +
      `- If Status is OVER and Headroom is not positive or missing, choose "cut costs" or "increase budget"\n` +
      `- If Status is WATCH, prefer "reallocate budget"\n` +
      `- If Status is OK, choose the best action (often "reallocate budget" is fine)\n` +
      `- Set AITolerance based on AllowedVariancePct if provided (0.05 strict, 0.10 moderate, 0.20 loose)\n`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Return JSON only. Do not include markdown. Do not include extra keys."
          },
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

    // Parse model output; if it fails, fall back to deterministic output
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    // Validate/normalize output
    const aiActionAllowed = new Set(["cut costs", "reallocate budget", "increase budget"]);
    const tolAllowed = new Set(["strict", "moderate", "loose"]);

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

    // Optional backward-compatible keys (won't hurt Zapier)
    finalOut.summary = finalOut.VarianceSummary;
    finalOut.tolerance = finalOut.AITolerance;
    finalOut.recommendation = finalOut.AIAction;

    return res.status(200).json(finalOut);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
