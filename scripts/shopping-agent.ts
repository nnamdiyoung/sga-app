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
  asin: string;
}

interface SelectedProduct {
  grocery_item_name: string;
  product_name: string;
  price: number;
  image_url: string;
  product_url: string;  // always https://www.amazon.ca/dp/[ASIN]
  store: string;        // always "Amazon.ca"
  swapped: boolean;
  quantity: string;
  asin?: string;
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

async function solvePressAndHold(page: Page, buttonText: string): Promise<void> {
  try {
    const btn = page.getByText(buttonText, { exact: false }).first();
    const box = await btn.boundingBox();
    if (!box) { await btn.click({ force: true }).catch(() => {}); return; }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(3500);
    await page.mouse.up();
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`[CAPTCHA] Hold error: ${e}`);
  }
}

// ─── Amazon search — Claude Vision reads the page ────────────────────────────

async function searchAmazon(page: Page, query: string): Promise<SearchResult[]> {
  const searchUrl = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    console.log(`[SEARCH] Navigation error: ${err}`);
    return [];
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(4000);
    const screenshot = (await page.screenshot()).toString("base64");
    await saveScreenshot(page, `search-${query.replace(/\s/g, "_").substring(0, 15)}`);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
          {
            type: "text",
            text: `Amazon Canada search results for "${query}". Respond with exactly ONE of:

CAPTCHA: <describe the challenge>

PRODUCTS: [{"name":"...","price":19.99,"asin":"B0XXXXXXXXX","image_url":"https://..."}]

EMPTY

LOADING

Rules:
- CAPTCHA if there is any robot check, verification, or CAPTCHA page
- PRODUCTS if product listings are visible — extract up to 6 best matches. ASIN is the 10-character alphanumeric code (starts with B) found in product URLs like /dp/B0XXXXXXXXX/. Price as a number. Image URL if visible.
- EMPTY if search completed but no products found
- LOADING if the page is still loading
- Respond ONLY with the keyword and data, nothing else`,
          },
        ],
      }],
    });

    const reply = (response.content[0] as Anthropic.TextBlock).text.trim();
    console.log(`[SEARCH] "${query}" (${attempt + 1}): ${reply.substring(0, 120)}`);

    if (reply.startsWith("CAPTCHA:")) {
      await page.waitForTimeout(6000);
      try { await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {}
      continue;
    }
    if (reply.startsWith("LOADING")) continue;
    if (reply.startsWith("EMPTY")) return [];

    if (reply.startsWith("PRODUCTS:")) {
      try {
        const jsonStr = reply.replace(/^PRODUCTS:\s*/i, "").trim();
        const arr = JSON.parse(jsonStr.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
        const results: SearchResult[] = arr
          .filter((p: any) => p.name && p.asin)
          .map((p: any) => ({
            name: String(p.name),
            price: parseFloat(String(p.price ?? 0).replace(/[^0-9.]/g, "")) || 0,
            image: String(p.image_url ?? ""),
            product_url: `https://www.amazon.ca/dp/${String(p.asin).trim()}`,
            asin: String(p.asin).trim(),
          }));
        console.log(`[SEARCH] "${query}" → ${results.length} products`);
        return results;
      } catch (e) {
        console.log(`[SEARCH] Parse error: ${e}`);
        return [];
      }
    }
  }

  console.log(`[SEARCH] "${query}" → 0 results after all attempts`);
  return [];
}

// ─── Agentic full-basket shopper ─────────────────────────────────────────────

const SHOPPING_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_amazon",
    description: "Search Amazon Canada for a household product. Returns products with names, prices, and ASINs. If you get 0 results, try a shorter or simpler search term.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g. 'paper towels', 'dish soap', 'laundry detergent')" },
      },
      required: ["query"],
    },
  },
  {
    name: "finalize_cart",
    description: "Submit your final product selections. Call once you have found products for all items (or exhausted searches).",
    input_schema: {
      type: "object" as const,
      properties: {
        selections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              grocery_item_name: { type: "string", description: "Original item name from the user's list" },
              product_name: { type: "string", description: "Exact product name from Amazon" },
              price: { type: "number", description: "Price in CAD. Never return 0 — estimate if needed." },
              product_url: { type: "string", description: "Amazon product URL (https://www.amazon.ca/dp/ASIN)" },
              image_url: { type: "string", description: "Product image URL (empty string if none)" },
              store: { type: "string", description: "Always 'Amazon.ca'" },
              asin: { type: "string", description: "10-character Amazon ASIN (e.g. B0XXXXXXXXX)" },
              not_found: { type: "boolean", description: "True only if the item genuinely couldn't be found after trying" },
            },
            required: ["grocery_item_name", "product_name", "price", "product_url", "image_url", "store", "asin", "not_found"],
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
): Promise<SelectedProduct[]> {
  const itemList = items.map(i =>
    i.quantity && i.quantity !== '1'
      ? `- ${i.name} [buy ${i.quantity}]`
      : `- ${i.name}`
  ).join("\n");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `You are a smart household shopping assistant. Find the following household items on Amazon Canada (amazon.ca):

${itemList}

User preferences:
- Budget: $${profile.budget ?? "flexible"} CAD
- Preferences: ${profile.dietary?.join(", ") || "none"}
- Avoid: ${profile.allergies?.join(", ") || "none"}
- Preferred brands: ${profile.brands || "no strong preference"}

Shopping strategy:
- Respect any avoid/allergy restrictions — never pick something that violates them.
- If budget is set, prefer value options.
- If a search returns 0 results, try a simpler term before giving up.
- Prefer items with ASINs (required for the Amazon cart to work).
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

      if (block.name === "search_amazon") {
        const { query } = block.input as { query: string };
        const results = await searchAmazon(page, query);

        const resultText = results.length > 0
          ? `Found ${results.length} products on Amazon.ca:\n` +
            results.map((r, i) =>
              `${i + 1}. ${r.name} — $${r.price > 0 ? r.price : "price not shown"} CAD | ASIN: ${r.asin} | URL: ${r.product_url} | Image: ${r.image}`
            ).join("\n")
          : `No results for "${query}". Try a simpler or different search term.`;

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      }

      else if (block.name === "finalize_cart") {
        const { selections } = block.input as {
          selections: Array<{
            grocery_item_name: string; product_name: string; price: number;
            product_url: string; image_url: string; store: string; asin: string; not_found: boolean;
          }>;
        };

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
            product_url: s.product_url || `https://www.amazon.ca/s?k=${encodeURIComponent(s.grocery_item_name)}`,
            store: "Amazon.ca",
            swapped: false,
            quantity: original?.quantity ?? "1",
            asin: s.asin || "",
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
      content: `Quick household cart review. Flag ONLY serious problems — wrong product category, allergen violations, or dietary violations.

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

// ─── Amazon cart URL builder ──────────────────────────────────────────────────

function buildAmazonCartUrl(products: SelectedProduct[]): string {
  const params: string[] = [];
  let idx = 1;
  for (const p of products) {
    const asin = p.asin || p.product_url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (asin) {
      params.push(`ASIN.${idx}=${asin}`, `Quantity.${idx}=1`);
      idx++;
    }
  }
  if (!params.length) return "https://www.amazon.ca";
  return `https://www.amazon.ca/gp/aws/cart/add.html?${params.join("&")}`;
}

// ─── Email summary (Claude-written) ──────────────────────────────────────────

async function generateEmailSummary(
  selectedProducts: SelectedProduct[],
  total: number,
  amazonCartUrl: string,
): Promise<string> {
  const found = selectedProducts.filter(p => !p.product_name.startsWith('Search for "'));
  const notFound = selectedProducts.filter(p => p.product_name.startsWith('Search for "'));
  const stores = [...new Set(found.map(p => p.store).filter(Boolean))];

  const context = [
    `Found ${found.length} of ${selectedProducts.length} items.`,
    stores.length > 0 ? `Store(s): ${stores.join(", ")}.` : "",
    `Estimated total: ~$${total.toFixed(2)} CAD.`,
    notFound.length > 0 ? `Not found: ${notFound.map(p => p.grocery_item_name).join(", ")}.` : "",
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
      content: `Write a fun, warm, slightly playful HTML email body for a smart household shopping app called Restock. Personality: like a helpful friend who just did your shopping for you.

Shopping results:
${context}

Items found:
${itemLines}
${notFoundLines ? `\nNot found:\n${notFoundLines}` : ""}

Instructions:
- Start with a short punchy line (1 sentence) — make it fun, not corporate
- Then show the item list as HTML: each item on its own line with a relevant emoji at the start, the product name, and price. Use <ul> with no bullets (list-style:none), each <li> styled with padding.
- If items weren't found, mention them briefly at the end with a 😅 or similar
- End with a clear call to action: "Open your Amazon cart to add all items in one tap: <a href="${amazonCartUrl}">Open Amazon Cart →</a>"
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

// ─── Process one user ─────────────────────────────────────────────────────────

async function processUser(userId: string, browser: Browser): Promise<void> {
  const [itemsRes, profileRes] = await Promise.all([
    supabase.from("grocery_items").select("name, quantity").eq("user_id", userId).eq("cleared", false),
    supabase.from("profiles").select("*").eq("user_id", userId).single(),
  ]);

  const items: GroceryItem[] = itemsRes.data ?? [];
  const profile: Profile = profileRes.data ?? {} as Profile;

  if (!items.length) { console.log(`No items for ${userId}`); return; }
  console.log(`\nShopping ${items.length} items for user ${userId}`);

  const authRes = await supabase.auth.admin.getUserById(userId);
  const userEmail = authRes.data?.user?.email;
  if (!userEmail) return;

  // No auth cookies needed — Amazon doesn't require login for search
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-CA",
  });
  const page = await context.newPage();

  console.log(`\nStarting agentic shop for ${items.length} items on Amazon.ca...`);
  const selectedProducts = await shopForGroceries(page, items, profile);
  const validatedProducts = await validateCartWithClaude(selectedProducts, items, profile);

  await context.close();

  if (validatedProducts.length === 0) {
    console.log("No products found, skipping cart creation.");
    return;
  }

  const total = validatedProducts.reduce((sum, p) => sum + (p.price ?? 0), 0);
  const amazonCartUrl = buildAmazonCartUrl(validatedProducts);

  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .insert({ user_id: userId, status: "pending", total: parseFloat(total.toFixed(2)), platform: "amazon" })
    .select("id")
    .single();

  if (cartError || !cart) throw new Error(`Cart creation failed: ${cartError?.message}`);

  await supabase.from("cart_items").insert(
    validatedProducts.map((p) => ({
      cart_id: cart.id,
      grocery_item_name: p.grocery_item_name,
      product_name: p.product_name,
      price: p.price,
      image_url: p.image_url,
      product_url: p.product_url,
      store: p.store,
      swapped: false,
      quantity: p.quantity,
    }))
  );

  await supabase.from("grocery_items").update({ cleared: true }).eq("user_id", userId).eq("cleared", false);

  const emailBody = await generateEmailSummary(validatedProducts, total, amazonCartUrl);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: userEmail,
    subject: `🛒 Your Restock cart is ready — ${validatedProducts.length} items ~$${total.toFixed(2)} CAD`,
    html: emailBody,
  });

  console.log(`\nDone: ${validatedProducts.length} items, $${total.toFixed(2)} CAD`);
  console.log(`Amazon cart URL: ${amazonCartUrl}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Restock Agent starting...");
  const userIds = await getUsersToShopFor();
  console.log(`Users to shop for: ${userIds.length}`);
  if (!userIds.length) return;

  const browser = await chromium.launch({ headless: true });
  for (const userId of userIds) {
    try { await processUser(userId, browser); }
    catch (err) { console.error(`Error for ${userId}:`, err); }
  }
  await browser.close();
  console.log("Restock Agent done.");
}

main();
