import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error } = await supabase.auth.getUser()
  if (!user || error) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const { text } = await req.json()
  if (!text?.trim()) {
    return new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } })
  }

  // Fetch profile for dietary/allergy context
  const { data: profile } = await supabase
    .from('profiles')
    .select('dietary, allergies, budget')
    .eq('user_id', user.id)
    .single()

  const dietary = profile?.dietary?.join(', ') || 'none'
  const allergies = profile?.allergies?.join(', ') || 'none'

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are a smart grocery assistant. Convert this request into a structured grocery list.

User request: "${text}"
Dietary preferences: ${dietary}
Allergies: ${allergies}

Return ONLY a valid JSON array — no explanation, no markdown, no extra text:
[{"name": "item name", "quantity": "amount (e.g. '2', '500g', '1 dozen', '1')"}]

Rules:
- Use common grocery store names (what you'd search for)
- Keep names short and specific (1–4 words)
- Infer quantities from context ("for 4 people", "weekly", etc.)
- Respect dietary preferences and allergies — never include restricted items
- If the request mentions a meal, include all the main ingredients
- If the request is already a single grocery item, return it as-is
- If unclear or not food-related, return []`,
    }],
  })

  const raw = (msg.content[0] as Anthropic.TextBlock).text.trim()
  let items: { name: string; quantity: string }[] = []
  try {
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) items = JSON.parse(match[0])
  } catch { /* return empty */ }

  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
