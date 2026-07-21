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
    const raw = p.price ?? p.unit_price ?? p.pricing?.price ?? p.pricing?.unit_price ??
      p.pricing?.display_price ?? p.attributes?.price ?? p.displayPrice ?? p.display_price ?? 0;
    const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? 0 : n;
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

      for (const p of candidates) {
        if (results.length >= 8) break;
        const name = p.name ?? p.display_name ?? p.displayName ?? p.title;
        if (!name) continue;
        const itemId: string = String(p.id ?? p.item_id ?? p.itemId ?? "");
        const productId: string = String(p.productId ?? p.legacyId ?? p.legacy_id ?? "");
        const numericId = productId || itemId.match(/(\d+)$/)?.[1] || "";
        let product_url = p.url ?? p.product_url ?? "";
        if (numericId) product_url = `https://www.instacart.ca/products/${numericId}`;

        results.push({
          name,
          price: extractPrice(p),
          image: p.image_url ?? p.image ?? p.photo ?? p.imageUrl ?? "",
          product_url,
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
              grocery_item_name: { type: "string", description: "Original grocery list item name" },
              product_name: { type: "string", description: "Exact product name found" },
              price: { type: "number", description: "Price in CAD (estimate if shown as 0)" },
              product_url: { type: "string", description: "Product URL from search results" },
              image_url: { type: "string", description: "Image URL (empty string if none)" },
              store: { type: "string", description: "Store name" },
              not_found: { type: "boolean", description: "True if item couldn't be found after trying" },
            },
            required: ["grocery_item_name", "product_name", "price", "product_url", "image_url", "store", "not_found"],
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
  const itemList = items.map(i => `- ${i.name} (qty: ${i.quantity})`).join("\n");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `You are a smart grocery shopper. Buy the following items on Instacart Canada:

${itemList}

User preferences:
- Budget: $${profile.budget ?? "flexible"} CAD
- Dietary: ${profile.dietary?.join(", ") || "none"}
- Allergies: ${profile.allergies?.join(", ") || "none"}
- Preferred brands: ${profile.brands || "no strong preference"}

Be smart about this:
- Try to get everything from one store — it's better for the user (one checkout)
- But don't skip an item just to stay in one store; finding the item matters more
- If a search returns nothing, try a shorter or different term before giving up
- Pick good value products that match the user's preferences and dietary needs
- Once you have everything (or have genuinely tried), call finalize_cart with all your selections

Search however makes sense to you. Use your judgment.`,
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
              `${i + 1}. ${r.name} — $${r.price > 0 ? r.price : "price not shown"} CAD | URL: ${r.product_url} | Image: ${r.image}`
            ).join("\n")
          : `No results for "${query}". Try a simpler or different search term.`;

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      }

      else if (block.name === "finalize_cart") {
        const { selections } = block.input as {
          selections: Array<{
            grocery_item_name: string; product_name: string; price: number;
            product_url: string; image_url: string; store: string; not_found: boolean;
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
  if (preferredStore) console.log(`Store preference: ${preferredStore} (hint only — Claude decides)`);

  console.log(`\nStarting agentic shop for ${items.length} items...`);
  const selectedProducts = await shopForGroceries(page, items, profile);
  await context.close();

  if (selectedProducts.length === 0) {
    console.log("No products found, skipping cart creation.");
    return;
  }

  const total = selectedProducts.reduce((sum, p) => sum + (p.price ?? 0), 0);

  if (isMultiStoreRun) {
    await supabase.from("cart_items").insert(
      selectedProducts.map((p) => ({ cart_id: existingCartId, ...p }))
    );
    console.log(`Multi-store: added ${selectedProducts.length} items to cart ${existingCartId}`);
    return;
  }

  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .insert({ user_id: userId, status: "pending", total: parseFloat(total.toFixed(2)), platform: "instacart" })
    .select("id")
    .single();

  if (cartError || !cart) throw new Error(`Cart creation failed: ${cartError?.message}`);

  await supabase.from("cart_items").insert(selectedProducts.map((p) => ({ cart_id: cart.id, ...p })));
  await supabase.from("grocery_items").update({ cleared: true }).eq("user_id", userId).eq("cleared", false);

  const unfound = selectedProducts.filter((p) => p.product_name.startsWith('Search for "'));
  const itemListHtml = selectedProducts
    .map((p) => `<li><b>${p.grocery_item_name}</b> → ${p.product_name} ($${p.price.toFixed(2)} CAD) — ${p.store}</li>`)
    .join("\n");
  const unfoundNote = unfound.length > 0
    ? `<p>⚠️ <b>${unfound.length} item(s) not found</b>: ${unfound.map((p) => p.grocery_item_name).join(", ")}. Open the app to search other stores.</p>`
    : "";

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: userEmail,
    subject: `🛒 Cart ready — ${selectedProducts.length} items ~$${total.toFixed(2)} CAD`,
    html: `<h2>Your SGA cart is ready!</h2><ul>${itemListHtml}</ul>${unfoundNote}<p>Open the SGA app → Cart tab → Add to Instacart Cart.</p>`,
  });

  console.log(`\nDone: ${selectedProducts.length} items, $${total.toFixed(2)} CAD`);
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
