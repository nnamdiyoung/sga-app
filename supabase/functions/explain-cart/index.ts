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

  const { cart_items } = await req.json()
  if (!cart_items?.length) {
    return new Response(JSON.stringify({ summary: null }), { headers: { 'Content-Type': 'application/json' } })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('budget, dietary, allergies, brands')
    .eq('user_id', user.id)
    .single()

  const found = cart_items.filter((i: any) => !i.product_name?.startsWith('Search for "'))
  const notFound = cart_items.filter((i: any) => i.product_name?.startsWith('Search for "'))
  const stores = [...new Set(found.map((i: any) => i.store).filter(Boolean))]
  const total = cart_items.reduce((s: number, i: any) => s + (i.price ?? 0), 0)
  const budget = profile?.budget

  const context = [
    `Found ${found.length} of ${cart_items.length} items.`,
    stores.length > 0 ? `Shopping at: ${stores.join(' and ')}.` : '',
    `Estimated total: $${total.toFixed(2)} CAD${budget ? ` (budget: $${budget})` : ''}.`,
    notFound.length > 0
      ? `Couldn't find: ${notFound.map((i: any) => i.grocery_item_name).join(', ')}.`
      : 'All items found.',
    found.length > 0
      ? `Items: ${found.map((i: any) => `${i.product_name} for ${i.grocery_item_name}`).join('; ')}.`
      : '',
  ].filter(Boolean).join(' ')

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `Write a single brief, friendly sentence summarising this grocery cart for the user. Be specific — mention the store, count, and anything notable (great deal, item not found, over budget). No greeting, no punctuation at end, no markdown.\n\n${context}`,
    }],
  })

  const summary = (msg.content[0] as Anthropic.TextBlock).text.trim().replace(/\.$/, '')

  return new Response(JSON.stringify({ summary }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
