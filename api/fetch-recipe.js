// Vercel Serverless Function — /api/fetch-recipe
// Accepts a POST with { url }. Fetches the page server-side, strips it to text,
// and asks Claude to extract a structured recipe. Returns recipe JSON.
//
// NOTE: This file is ESM (package.json has "type": "module") and calls the
// Anthropic REST API directly with fetch — it does NOT use the @anthropic-ai/sdk
// package (which isn't installed). The previous version used CommonJS
// (require/module.exports) and the SDK, which threw on load and returned HTTP 500.

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { url } = req.body || {};
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  try {
    // Fetch the page server-side
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!pageRes.ok) {
      return res.status(400).json({
        error: `Could not load that page (HTTP ${pageRes.status}). The site may block automated access or require a login.`
      });
    }

    const html = await pageRes.text();

    // Strip scripts, styles, and tags — keep readable text only
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{3,}/g, '\n\n')
      .trim()
      .slice(0, 18000); // Claude handles ~18k chars cleanly

    if (text.length < 200) {
      return res.status(400).json({ error: 'Page content too short — the site may require JavaScript to load.' });
    }

    const prompt = `Extract the main recipe from this webpage text. Return ONLY valid JSON — no explanation, no markdown fences.

If you cannot find a recipe, return: {"error": "No recipe found on this page"}

JSON structure:
{
  "name": "Recipe Name",
  "servings": 4,
  "prepTime": 15,
  "cookTime": 30,
  "difficulty": "easy",
  "protein": "chicken",
  "cuisine": "american",
  "course": "dinner",
  "tags": ["tag1"],
  "ingredients": [{"quantity": "2", "unit": "cups", "name": "flour", "prep": "sifted", "storeSection": "pantry", "freshness": "normal"}],
  "instructions": ["Step 1...", "Step 2..."],
  "notes": ""
}

Rules:
- difficulty: easy | medium | hard
- protein: chicken | beef | pork | fish | seafood | vegetarian | eggs | mixed | other
- cuisine: italian | mexican | american | asian | mediterranean | other
- course: dinner | lunch | breakfast | side | dessert
- storeSection: produce | meat | dairy | frozen | pantry | bakery | other
- freshness: "short-shelf" for highly perishable items (fresh herbs, berries, leafy greens, fresh fish), otherwise "normal"
- quantity must always be a string (e.g. "2/3", "1", "2-3")
- prepTime and cookTime are integers in minutes (0 if unknown)

WEBPAGE TEXT:
${text}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Upstream API error while reading the recipe.' });
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content?.[0]?.text || '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not extract a recipe from that page.' });
    }

    const recipe = JSON.parse(jsonMatch[0]);
    if (recipe.error) {
      return res.status(400).json({ error: recipe.error });
    }

    return res.status(200).json(recipe);

  } catch (err) {
    console.error('fetch-recipe error:', err);
    if (err.name === 'TimeoutError') {
      return res.status(408).json({ error: 'The page took too long to load. Try again or use a different URL.' });
    }
    return res.status(500).json({ error: err.message || 'Failed to import recipe.' });
  }
}
