import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN')!
const GITHUB_REPO = 'nnamdiyoung/sga-app'
const WORKFLOW_FILE = 'shopping-agent.yml'

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

  const body = await req.json().catch(() => ({}))
  const storeSlug: string = body.store_slug ?? ''
  const itemNames: string = body.item_names ?? ''
  const cartId: string = body.cart_id ?? ''

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { force_run: 'true', store_slug: storeSlug, item_names: itemNames, cart_id: cartId },
      }),
    }
  )

  if (res.status === 204) {
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const text = await res.text()
  return new Response(JSON.stringify({ success: false, error: `GitHub ${res.status}: ${text}` }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
