const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      .slice(0, 18000); // Claude haiku handles ~18k chars cleanly

    if (text.length < 200) {
      return res.status(400).json({ error: 'Page content too short — the site may require JavaScript to load.' });
    }

    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Extract the main recipe from this webpage text. Return ONLY valid JSON — no explanation, no markdown fences.

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
  "ingredients": [{"quantity": "2", "unit": "cups", "name": "flour", "prep": "sifted"}],
  "instructions": ["Step 1...", "Step 2..."],
  "notes": ""
}

Rules:
- difficulty: easy | medium | hard
- protein: chicken | beef | pork | fish | seafood | vegetarian | eggs | mixed | other
- cuisine: italian | mexican | american | asian | mediterranean | other
- course: dinner | lunch | breakfast | side | dessert
- quantity must always be a string (e.g. "2/3", "1", "2-3")
- prepTime and cookTime are integers in minutes (0 if unknown)

WEBPAGE TEXT:
${text}`
      }]
    });

    const raw = message.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Could not extract a recipe from that page.' });
    }

    const recipe = JSON.parse(jsonMatch[0]);
    if (recipe.error) {
      return res.status(400).json({ error: recipe.error });
    }

    return res.json(recipe);

  } catch (err) {
    console.error('fetch-recipe error:', err);
    if (err.name === 'TimeoutError') {
      return res.status(408).json({ error: 'The page took too long to load. Try again or use a different URL.' });
    }
    return res.status(500).json({ error: err.message || 'Failed to import recipe.' });
  }
};
