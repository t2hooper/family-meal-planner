// Vercel Serverless Function — /api/parse-recipe
// Accepts a POST with:
//   { image, mimeType }         — single base64 image (in-app direct scan)
//   { images: [{data,mimeType}] } — multiple base64 images (multi-photo scan)
//   { imageUrl }                — Supabase Storage URL (iOS Shortcut queue)
// Calls Claude Vision with the server-side API key and returns
// structured recipe JSON plus per-field confidence scores.

export default async function handler(req, res) {
  // CORS headers — allow calls from the same Vercel deployment and localhost dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { image, mimeType, imageUrl, images } = req.body || {};

    // Build the array of image content blocks for the Claude API
    let imageBlocks = [];

    if (images && Array.isArray(images) && images.length > 0) {
      // Multi-photo: array of { data, mimeType } objects
      imageBlocks = images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data }
      }));
    } else if (imageUrl && !image) {
      // iOS Shortcut queue: remote URL — fetch and convert to base64
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
      const buf = await imgRes.arrayBuffer();
      const imageData = Buffer.from(buf).toString('base64');
      const ct = imgRes.headers.get('content-type');
      const imageMime = ct ? ct.split(';')[0].trim() : 'image/jpeg';
      imageBlocks = [{
        type: 'image',
        source: { type: 'base64', media_type: imageMime, data: imageData }
      }];
    } else if (image) {
      // Single base64 image (in-app direct scan)
      imageBlocks = [{
        type: 'image',
        source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image }
      }];
    } else {
      return res.status(400).json({ error: 'Provide image (base64), images (array), or imageUrl' });
    }

    const multiPhotoNote = imageBlocks.length > 1
      ? `There are ${imageBlocks.length} photos — they are all pages/screenshots of the SAME recipe. Combine them into one complete recipe JSON.`
      : 'Extract the recipe from this image.';

    const prompt = `You are extracting a recipe from the image${imageBlocks.length > 1 ? 's' : ''}. ${multiPhotoNote} Output ONLY a single JSON object — no markdown, no explanation, no code block.

Use exactly this structure:
{
  "name": "Recipe Name",
  "servings": 5,
  "prepTime": 15,
  "cookTime": 30,
  "difficulty": "easy",
  "protein": "chicken",
  "cuisine": "american",
  "course": "dinner",
  "tags": ["sheet-pan", "kid-friendly"],
  "ingredients": [
    { "name": "chicken thighs", "quantity": "2", "unit": "lbs", "prep": "bone-in skin-on", "group": "", "freshness": "medium-shelf", "storeSection": "meat" }
  ],
  "instructions": [
    "Preheat oven to 425°F.",
    "Season chicken with salt and pepper."
  ],
  "notes": "",
  "confidence": {
    "name": 95,
    "servings": 80,
    "prepTime": 60,
    "cookTime": 75,
    "difficulty": 70,
    "protein": 90,
    "cuisine": 85,
    "course": 90,
    "tags": 65,
    "ingredients": 88,
    "instructions": 92
  }
}

Rules:
- difficulty: "easy" | "medium" | "hard"
- protein: "chicken" | "beef" | "pork" | "fish" | "seafood" | "vegetarian" | "eggs" | "mixed"
- cuisine: "italian" | "mexican" | "american" | "asian" | "mediterranean" | "other"
- course: "dinner" | "lunch" | "breakfast" | "side" | "dessert"
- freshness: "long-shelf" | "medium-shelf" | "short-shelf"
- storeSection: "produce" | "meat" | "dairy" | "frozen" | "pantry" | "bakery" | "other"
- "quantity" must always be a string (e.g. "2/3", "1", "2-3"), never a number
- Do NOT scale, convert, round, or split ingredient quantities — preserve exactly as written
- If servings not shown, set "servings": "unspecified"
- confidence values are integers 0–100 reflecting how clearly each field was readable in the image(s)
- Output raw JSON only.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Upstream API error', detail: err });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // Strip any accidental markdown code fences before parsing
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('parse-recipe error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
