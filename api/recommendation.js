
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { Division, Category, VendorSource, Amount, Notes } = req.body || {};

    // Basic validation
    if (!Division || !Category || !Amount) {
      return res.status(400).json({
        error: "Missing required fields: Division, Category, Amount"
      });
    }

    // Call OpenAI
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }

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
              "You are an AI finance assistant for a fintech SaaS company. Be concise, business-focused, and action-oriented. Return JSON only."
          },
          {
            role: "user",
            content:
              `New expense submitted:\n` +
              `Division: ${Division}\n` +
              `Category: ${Category}\n` +
              `VendorSource: ${VendorSource || ""}\n` +
              `Amount: ${Amount}\n` +
              `Notes: ${Notes || ""}\n\n` +
              `Do ALL of the following and return JSON ONLY with keys: summary, tolerance, recommendation.\n` +
              `- tolerance must be one of: strict (5%), moderate (10%), loose (20%).\n` +
              `- recommendation should be 1 action: cut costs, reallocate budget, or increase budget.\n`
          }
        ]
      })
    });

    const data = await response.json();

    const text = data?.choices?.[0]?.message?.content || "";

    // Attempt to parse JSON response, otherwise wrap it
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { summary: "", tolerance: "", recommendation: text };
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
