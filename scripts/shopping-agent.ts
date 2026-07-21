import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { chromium, Browser, Page } from "playwright";
import { Resend } from "resend";
import * as fs from "fs";
import * as path from "path";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const resend = new Resend(process.env.RESEND_API_KEY!);

const SCREENSHOT_DIR = "/tmp/sga-screenshots";

interface Profile {
  user_id: string;
  budget: number;
  dietary: string[];
  allergies: string[];
  brands: string;
  instacart_session: string;
  preferred_store_slug?: string;
}

interface GroceryItem {
  name: string;
  quantity: string;
}

interface SearchResult {
  name: string;
  price: number;
  image: string;
  product_url: string;
  instacart_item_id: string;
}

interface SelectedProduct {
  grocery_item_name: string;
  product_name: string;
  price: number;
  image_url: string;
  product_url: string;
  store: string;
  swapped: boolean;
  quantity: string;
  instacart_item_id: string;
}

// ─── Schedule ────────────────────────────────────────────────────────────────

function isEasternDST(date: Date): boolean {
  const year = date.getUTCFullYear();
  const marchStart = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - marchStart.getUTCDay()) % 7, 7));
  const novStart = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - novStart.getUTCDay()) % 7, 6));
  return date >= dstStart && date < dstEnd;
}

function getEasternTime(date: Date): { hour: number; day: number } {
  const offset = isEasternDST(date) ? -4 : -5;
  const et = new Date(date.getTime() + offset * 3600000);
  return { hour: et.getUTCHours(), day: et.getUTCDay() };
}

async function getUsersToShopFor(): Promise<string[]> {
  const forceRun = process.env.FORCE_RUN === "true";
  const { hour, day } = getEasternTime(new Date());
  console.log(`ET: day=${day}, hour=${hour}${forceRun ? " (FORCE)" : ""}`);

  const { data, error } = await supabase.from("schedules").select("user_id, days, time").eq("active", true);
  if (error || !data) return [];

  return data
    .filter((s) => {
      if (forceRun) return true;
      const schedHour = parseInt(s.time.split(":")[0]);
      return s.days.includes(day) && schedHour === hour;
    })
    .map((s) => s.user_id);
}

// ─── Browser helpers ──────────────────────────────────────────────────────────

async function saveScreenshot(page: Page, label: string): Promise<void> {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${label}-${Date.now()}.png`), fullPage: false });
  } catch { /* non-fatal */ }
}

function slugToStoreName(slug: string): string {
  return slug
    .replace(/-(?:on|qc|bc|ab|mb|sk|ns|nb|pe|nl|nt|yt|nu)$/i, "")
    .replace(/-/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Instacart search (intercepts API responses) ───────────────────────────

async function searchInstacart(
  page: Page,
  query: string,
  storeSlug?: string
): Promise<{ results: SearchResult[]; detectedStoreSlug: string }> {
  const results: SearchResult[] = [];

  function extractPrice(p: any): number {
    // Try every known Instacart price field path (numeric and string display)
    const candidates = [
      p.price, p.unit_price, p.unitPrice,
      p.pricing?.price, p.pricing?.unit_price, p.pricing?.unitPrice,
      p.pricing?.display_price, p.pricing?.displayPrice, p.pricing?.displayString,
      p.pricing?.display_string, p.attributes?.price,
      p.displayPrice, p.display_price, p.priceString, p.price_string,
      // nested item wrapper (GraphQL)
      p.item?.price, p.item?.pricing?.price, p.item?.pricing?.displayPrice,
      p.item?.pricing?.displayString,
    ];
    for (const v of candidates) {
      if (v == null) continue;
      const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
      if (!isNaN(n) && n > 0) return n;
    }
    return 0;
  }

  const handler = async (response: any) => {
    const url: string = response.url();
    if (!url.includes("instacart")) return;
    if (!(response.headers()["content-type"] ?? "").includes("application/json")) return;
    try {
      const json = await response.json();
      const candidates: any[] =
        json?.items ?? json?.results ?? json?.products ??
        json?.data?.items ?? json?.data?.products ?? json?.data?.search?.products ??
        json?.modules?.flatMap((m: any) => m.items ?? m.products ?? []) ?? [];

      if (candidates.length > 0 && results.length === 0) {
        console.log('[PRICE DEBUG] First candidate keys:', Object.keys(candidates[0]));
        console.log('[PRICE DEBUG] First candidate:', JSON.stringify(candidates[0]).substring(0, 800));
      }

      for (const p of candidates) {
        if (results.length >= 8) break;
        const name = p.name ?? p.display_name ?? p.displayName ?? p.title;
        if (!name) continue;
        const itemId: string = String(p.id ?? p.item_id ?? p.itemId ?? "");
        const productId: string = String(p.productId ?? p.legacyId ?? p.legacy_id ?? "");
        const numericId = productId || itemId.match(/(\d+)$/)?.[1] || "";
        let product_url = p.url ?? p.product_url ?? "";
        if (numericId) product_url = `https://www.instacart.ca/products/${numericId}`;

        // Try to get the full "items_{locationId}-{productId}" format directly from the API
        const rawId = String(p.id ?? p.item_id ?? p.itemId ?? p.v4ItemId ?? p.v4_item_id ?? '')
        const fullItemId = /^items_\d+-\d+$/.test(rawId) ? rawId : ''

        results.push({
          name,
          price: extractPrice(p),
          image: p.image_url ?? p.image ?? p.photo ?? p.imageUrl ?? "",
          product_url,
          instacart_item_id: fullItemId,
        });
      }
    } catch { /* skip */ }
  };

  page.on("response", handler);

  // Always use generic URL — store-specific URLs don't reliably trigger API responses
  // in headless Chrome. We capture the redirected store and use it for product URLs only.
  const searchUrl = `https://www.instacart.ca/store/s?k=${encodeURIComponent(query)}`;

  let detectedStoreSlug = "";
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(7000);
    const match = page.url().match(/\/store\/([^/?#]+)/);
    if (match && match[1] !== "s") detectedStoreSlug = match[1];
    await saveScreenshot(page, `search-${query.replace(/\s/g, "_").substring(0, 15)}`);
  } catch (err) {
    console.log(`Search navigation error: ${err}`);
  }

  page.off("response", handler);

  // Rewrite generic /products/{id} URLs to store-specific ones so WebView sees
  // an active-store product page (with "Add to cart") rather than the storeless
  // page that shows "Buy now at Instacart" and requires a store picker flow.
  if (detectedStoreSlug) {
    for (const result of results) {
      const idMatch = result.product_url.match(/\/products\/(\d+)/);
      if (idMatch) {
        result.product_url = `https://www.instacart.ca/store/${detectedStoreSlug}/products/${idMatch[1]}`;
      }
    }
  }

  console.log(`Search "${query}" → ${results.length} results (store: ${detectedStoreSlug || "unknown"})`);
  return { results, detectedStoreSlug };
}

// ─── Agentic full-basket shopper ─────────────────────────────────────────────

const SHOPPING_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_instacart",
    description: "Search Instacart for a product. Returns products with names, prices, URLs, and which store they're from. If you get 0 results, try a shorter or simpler search term.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g. 'eggs', 'brioche', 'paper towels')" },
      },
      required: ["query"],
    },
  },
  {
    name: "finalize_cart",
    description: "Submit your final product selections for the entire grocery list. Call this once you've found products for all items (or exhausted searches).",
    input_schema: {
      type: "object" as const,
      properties: {
        selections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              grocery_item_name: { type: "string", description: "Original grocery list item name only — e.g. 'Apple juice', never include qty info like '(qty: 1)'" },
              product_name: { type: "string", description: "Exact product name found" },
              price: { type: "number", description: "Price in CAD. If shown as 'price not shown' or 0, estimate a reasonable Canadian grocery price (e.g. bread ~$4, butter ~$6, juice ~$5). Never return 0." },
              product_url: { type: "string", description: "Product URL from search results" },
              image_url: { type: "string", description: "Image URL (empty string if none)" },
              store: { type: "string", description: "Store name" },
              not_found: { type: "boolean", description: "True if item couldn't be found after trying" },
              instacart_item_id: { type: "string", description: "Full Instacart item ID like items_35816-17880670 (use 'unknown' if not available)" },
            },
            required: ["grocery_item_name", "product_name", "price", "product_url", "image_url", "store", "not_found", "instacart_item_id"],
          },
        },
      },
      required: ["selections"],
    },
  },
];

async function shopForGroceries(
  page: Page,
  items: GroceryItem[],
  profile: Profile,
  preferredStore?: string,
): Promise<SelectedProduct[]> {
  const itemList = items.map(i =>
    i.quantity && i.quantity !== '1'
      ? `- ${i.name} [buy ${i.quantity}]`
      : `- ${i.name}`
  ).join("\n");
  const storeHint = preferredStore
    ? `\nStore preference: The user wants to shop at ${preferredStore}. Search there first. Only look elsewhere if something is genuinely unavailable.`
    : "";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `You are a smart grocery shopper. Buy the following items on Instacart Canada:

${itemList}

User preferences:
- Budget: $${profile.budget ?? "flexible"} CAD
- Dietary: ${profile.dietary?.join(", ") || "none"}
- Allergies: ${profile.allergies?.join(", ") || "none"}
- Preferred brands: ${profile.brands || "no strong preference"}${storeHint}

Shopping strategy:
- **Strongly prefer one store** — the user gets one checkout, one delivery. This matters a lot.
- Identify which store Instacart defaults to from your first search, then commit to it.
- Only switch stores if an item is genuinely unavailable after 2 search attempts, OR if the price difference is extreme (e.g. 50%+ cheaper elsewhere for a high-cost item).
- Never split stores just because another store is slightly cheaper — the convenience of one checkout is worth a few dollars.
- Respect dietary restrictions and allergies strictly — never pick something that violates them.
- If budget is set and total looks high, prefer store-brand or value options within the same store before going elsewhere.
- If a search returns 0 results, try a simpler term before giving up.
- Once you have everything (or genuinely exhausted options), call finalize_cart.

Use your judgment. Be decisive.`,
    },
  ];

  let finalSelections: SelectedProduct[] = [];
  let isDone = false;

  for (let turn = 0; turn < 20 && !isDone; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      tools: SHOPPING_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "search_instacart") {
        const { query } = block.input as { query: string };
        const { results, detectedStoreSlug } = await searchInstacart(page, query);
        const storeName = detectedStoreSlug ? slugToStoreName(detectedStoreSlug) : "Instacart";

        const resultText = results.length > 0
          ? `Found ${results.length} products at ${storeName}:\n` +
            results.map((r, i) =>
              `${i + 1}. ${r.name} — $${r.price > 0 ? r.price : "price not shown"} CAD | URL: ${r.product_url} | ItemID: ${r.instacart_item_id || 'unknown'} | Image: ${r.image}`
            ).join("\n")
          : `No results for "${query}". Try a simpler or different search term.`;

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      }

      else if (block.name === "finalize_cart") {
        const { selections } = block.input as {
          selections: Array<{
            grocery_item_name: string; product_name: string; price: number;
            product_url: string; image_url: string; store: string; not_found: boolean;
            instacart_item_id: string;
          }>;
        };

        // Map back to SelectedProduct, filling in quantity from original items
        finalSelections = selections.map((s) => {
          const original = items.find(i => i.name.toLowerCase() === s.grocery_item_name.toLowerCase());
          console.log(s.not_found
            ? `✗ ${s.grocery_item_name} — not found`
            : `✓ ${s.grocery_item_name} → ${s.product_name} @ $${s.price} (${s.store})`
          );
          return {
            grocery_item_name: s.grocery_item_name,
            product_name: s.not_found ? `Search for "${s.grocery_item_name}"` : s.product_name,
            price: s.price,
            image_url: s.image_url,
            product_url: s.product_url || `https://www.instacart.ca/store/s?k=${encodeURIComponent(s.grocery_item_name)}`,
            store: s.store,
            swapped: false,
            quantity: original?.quantity ?? "1",
            instacart_item_id: s.instacart_item_id ?? '',
          };
        });

        isDone = true;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Cart finalized." });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  return finalSelections;
}

// ─── Claude cart validation ───────────────────────────────────────────────────

async function validateCartWithClaude(
  selectedProducts: SelectedProduct[],
  originalItems: GroceryItem[],
  profile: Profile,
): Promise<SelectedProduct[]> {
  const found = selectedProducts.filter(p => !p.product_name.startsWith('Search for "'));
  if (!found.length) return selectedProducts;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Quick grocery cart review. Flag ONLY serious problems — wrong product category, allergen violations, or dietary violations.

User dietary: ${profile.dietary?.join(', ') || 'none'}
User allergies: ${profile.allergies?.join(', ') || 'none'}

Selected products:
${found.map(p => `- "${p.grocery_item_name}" → ${p.product_name} @ $${p.price}`).join('\n')}

Return a JSON array of problems. Each entry: {"item": "grocery_item_name", "problem": "brief reason"}.
If everything is fine, return [].
Return ONLY the JSON array, no other text.`,
    }],
  });

  const raw = (msg.content[0] as Anthropic.TextBlock).text.trim();
  let problems: { item: string; problem: string }[] = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) problems = JSON.parse(m[0]);
  } catch { /* ignore parse errors */ }

  if (problems.length > 0) {
    console.log('\n⚠️  Claude cart review flagged issues:');
    for (const p of problems) console.log(`  ✗ ${p.item}: ${p.problem}`);
  } else {
    console.log('\n✓ Claude cart review: all selections look good');
  }

  return selectedProducts;
}

// ─── Claude-guided Instacart cart addition (vision) ──────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function addProductWithClaude(page: Page, product: SelectedProduct, workerIdx: number): Promise<boolean> {
  if (!product.product_url || product.product_name.startsWith('Search for "')) return false;

  try {
    await page.goto(product.product_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    if (page.url().includes("/login") || page.url().includes("/sign_in")) {
      console.log(`[W${workerIdx}] Session expired`);
      return false;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const screenshot = (await page.screenshot()).toString("base64");

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
            {
              type: "text",
              text: `Instacart Canada product page. Add "${product.product_name}" to cart.

Reply with exactly one of:
CLICK: <exact text on the Add to cart button>
DISMISS: <exact text on the popup close button>
DONE
FAIL: <reason>`,
            },
          ],
        }],
      });

      const reply = ((response.content[0] as Anthropic.TextBlock).text ?? "").trim();
      console.log(`[W${workerIdx}] ${product.grocery_item_name} (${attempt + 1}): ${reply}`);

      if (reply.startsWith("DONE")) return true;
      if (reply.startsWith("FAIL")) return false;

      const clickMatch = reply.match(/^CLICK:\s*(.+)/i);
      const dismissMatch = reply.match(/^DISMISS:\s*(.+)/i);
      const label = (clickMatch?.[1] ?? dismissMatch?.[1] ?? "").trim();
      if (!label) return false;

      const clicked = await page.getByRole("button", { name: label, exact: false }).first()
        .click({ force: true })
        .then(() => true)
        .catch(() =>
          page.getByText(label, { exact: false }).first()
            .click({ force: true })
            .then(() => true)
            .catch(() => false)
        );

      if (!clicked) { console.log(`[W${workerIdx}] Couldn't click "${label}"`); return false; }
      await page.waitForTimeout(1500);

      if (clickMatch) return true;
      // DISMISS → loop and try again with fresh screenshot
    }
  } catch (err) {
    console.log(`[W${workerIdx}] Error on ${product.grocery_item_name}: ${err}`);
  }

  return false;
}

async function addProductsParallel(browser: Browser, profile: Profile, products: SelectedProduct[]): Promise<number> {
  const valid = products.filter(p => p.product_url && !p.product_name.startsWith('Search for "'));
  if (!valid.length) return 0;

  const WORKERS = Math.min(3, valid.length);
  const chunks = chunkArray(valid, Math.ceil(valid.length / WORKERS));
  console.log(`\nAdding ${valid.length} items to Instacart (${WORKERS} parallel workers)...`);

  const counts = await Promise.all(
    chunks.map(async (chunk, idx) => {
      const ctx = await buildBrowserContext(browser, profile);
      const page = await ctx.newPage();
      let added = 0;
      for (const product of chunk) {
        const ok = await addProductWithClaude(page, product, idx + 1);
        console.log(ok ? `✓ [W${idx + 1}] ${product.product_name}` : `✗ [W${idx + 1}] ${product.grocery_item_name}`);
        if (ok) added++;
      }
      await ctx.close();
      return added;
    })
  );

  return counts.reduce((s, n) => s + n, 0);
}

// ─── Email summary (Claude-written) ──────────────────────────────────────────

async function generateEmailSummary(
  selectedProducts: SelectedProduct[],
  total: number,
  instacartAdded: boolean,
  addedCount: number,
): Promise<string> {
  const found = selectedProducts.filter(p => !p.product_name.startsWith('Search for "'));
  const notFound = selectedProducts.filter(p => p.product_name.startsWith('Search for "'));
  const stores = [...new Set(found.map(p => p.store).filter(Boolean))];

  const context = [
    `Found ${found.length} of ${selectedProducts.length} items.`,
    stores.length > 0 ? `Store(s): ${stores.join(", ")}.` : "",
    `Estimated total: ~$${total.toFixed(2)} CAD.`,
    notFound.length > 0 ? `Not found: ${notFound.map(p => p.grocery_item_name).join(", ")}.` : "",
    instacartAdded
      ? `Successfully added ${addedCount} item(s) directly to the user's Instacart cart.`
      : "Items were not automatically added to Instacart (session may have expired).",
  ].filter(Boolean).join(" ");

  const itemLines = found.map(p =>
    `- ${p.grocery_item_name}: ${p.product_name} — $${p.price.toFixed(2)} at ${p.store}`
  ).join("\n");
  const notFoundLines = notFound.length > 0
    ? notFound.map(p => `- ${p.grocery_item_name}`).join("\n")
    : "";

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 900,
    messages: [{
      role: "user",
      content: `Write a fun, warm, slightly playful HTML email body for a smart grocery shopping app called SGA. Personality: like a helpful friend who just did your shopping for you.

Shopping results:
${context}

Items found:
${itemLines}
${notFoundLines ? `\nNot found:\n${notFoundLines}` : ""}

Instructions:
- Start with a short punchy line (1 sentence) — make it fun, not corporate
- Then show the item list as HTML: each item on its own line with a relevant food emoji at the start, the product name, and price. Use <ul> with no bullets (list-style:none), each <li> styled with padding.
- If items weren't found, mention them briefly at the end with a 😅 or similar
- End with a clear call to action: ${instacartAdded ? '"Your Instacart cart is loaded — just open Instacart and checkout! 🎉"' : '"Open SGA → Cart tab to add your items to Instacart"'}
- Keep the whole thing under 200 words
- Output ONLY raw HTML — no markdown, no backticks, no code fences, no \`\`\`html wrapper
- Start your response directly with the first HTML element`,
    }],
  });

  // Strip markdown code fences in case Claude wraps output despite instructions
  return (msg.content[0] as Anthropic.TextBlock).text
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// ─── Session setup ────────────────────────────────────────────────────────────

async function buildBrowserContext(browser: Browser, profile: Profile) {
  type SessionData = {
    storageState?: { cookies: any[]; origins: any[] };
    cookies?: string;
    localStorage?: Record<string, string>;
  };

  let sessionData: SessionData = {};
  if (profile?.instacart_session) {
    try { sessionData = JSON.parse(profile.instacart_session); } catch { /* skip */ }
  }

  if (sessionData.storageState) {
    console.log(`Using full storageState (${sessionData.storageState.cookies.length} cookies incl. HttpOnly)`);
    return browser.newContext({
      storageState: sessionData.storageState as any,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-CA",
    });
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-CA",
  });

  if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
    await context.addInitScript((ls) => {
      for (const [k, v] of Object.entries(ls)) {
        try { localStorage.setItem(k, v as string); } catch { }
      }
    }, sessionData.localStorage);
    console.log(`Injected ${Object.keys(sessionData.localStorage).length} localStorage entries`);
  }

  if (sessionData.cookies) {
    const parsed = sessionData.cookies.split(";")
      .map((c) => {
        const eq = c.indexOf("=");
        if (eq === -1) return null;
        return { name: c.substring(0, eq).trim(), value: c.substring(eq + 1).trim(), domain: ".instacart.ca", path: "/" };
      })
      .filter((c): c is NonNullable<typeof c> => !!c?.name && !!c?.value);
    if (parsed.length > 0) {
      await context.addCookies(parsed);
      console.log(`Injected ${parsed.length} session cookies`);
    }
  }

  return context;
}

// ─── Process one user ─────────────────────────────────────────────────────────

async function processUser(userId: string, browser: Browser): Promise<void> {
  const existingCartId = process.env.CART_ID ?? "";
  const itemNameFilter = process.env.ITEM_NAMES
    ? process.env.ITEM_NAMES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const isMultiStoreRun = existingCartId !== "" && itemNameFilter.length > 0;

  const [itemsRes, profileRes] = await Promise.all([
    supabase.from("grocery_items").select("name, quantity").eq("user_id", userId).eq("cleared", false),
    supabase.from("profiles").select("*").eq("user_id", userId).single(),
  ]);

  let items: GroceryItem[] = itemsRes.data ?? [];
  const profile: Profile = profileRes.data;

  if (itemNameFilter.length > 0) {
    items = items.filter((i) => itemNameFilter.includes(i.name.toLowerCase()));
    console.log(`Multi-store run: [${items.map((i) => i.name).join(", ")}]`);
  }

  if (!items.length) { console.log(`No items for ${userId}`); return; }

  console.log(`\nShopping ${items.length} items for user ${userId}`);

  const authRes = await supabase.auth.admin.getUserById(userId);
  const userEmail = authRes.data?.user?.email;
  if (!userEmail) return;

  const context = await buildBrowserContext(browser, profile);
  const page = await context.newPage();

  const preferredStore = process.env.STORE_SLUG ? slugToStoreName(process.env.STORE_SLUG) : null;
  if (preferredStore) console.log(`Store preference: ${preferredStore}`);

  console.log(`\nStarting agentic shop for ${items.length} items...`);
  const selectedProducts = await shopForGroceries(page, items, profile, preferredStore ?? undefined);

  // Claude reviews the cart for obvious errors (wrong category, allergen violations, etc.)
  const validatedProducts = await validateCartWithClaude(selectedProducts, items, profile);

  if (validatedProducts.length === 0) {
    await context.close();
    console.log("No products found, skipping cart creation.");
    return;
  }

  await context.close();

  // Add directly to the user's Instacart cart — parallel Claude-vision workers
  let instacartAdded = false;
  let addedCount = 0;
  if (profile.instacart_session) {
    addedCount = await addProductsParallel(browser, profile, validatedProducts);
    instacartAdded = addedCount > 0;
    console.log(`Instacart: ${addedCount}/${validatedProducts.filter(p => !p.product_name.startsWith('Search for "')).length} items added`);
  }

  const total = validatedProducts.reduce((sum, p) => sum + (p.price ?? 0), 0);

  if (isMultiStoreRun) {
    await supabase.from("cart_items").insert(
      validatedProducts.map((p) => ({ cart_id: existingCartId, ...p }))
    );
    console.log(`Multi-store: added ${validatedProducts.length} items to cart ${existingCartId}`);
    return;
  }

  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .insert({ user_id: userId, status: "pending", total: parseFloat(total.toFixed(2)), platform: "instacart" })
    .select("id")
    .single();

  if (cartError || !cart) throw new Error(`Cart creation failed: ${cartError?.message}`);

  await supabase.from("cart_items").insert(validatedProducts.map((p) => ({ cart_id: cart.id, ...p })));
  await supabase.from("grocery_items").update({ cleared: true }).eq("user_id", userId).eq("cleared", false);

  const emailBody = await generateEmailSummary(validatedProducts, total, instacartAdded, addedCount);
  const subject = instacartAdded
    ? `✅ ${addedCount} items added to Instacart — ~$${total.toFixed(2)} CAD`
    : `🛒 Cart ready — ${validatedProducts.length} items ~$${total.toFixed(2)} CAD`;

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: userEmail,
    subject,
    html: emailBody,
  });

  console.log(`\nDone: ${validatedProducts.length} items, $${total.toFixed(2)} CAD, Instacart added: ${instacartAdded}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("SGA Agent starting...");
  const userIds = await getUsersToShopFor();
  console.log(`Users to shop for: ${userIds.length}`);
  if (!userIds.length) return;

  const browser = await chromium.launch({ headless: true });
  for (const userId of userIds) {
    try { await processUser(userId, browser); }
    catch (err) { console.error(`Error for ${userId}:`, err); }
  }
  await browser.close();
  console.log("SGA Agent done.");
}

main();
