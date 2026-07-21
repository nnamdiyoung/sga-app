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

// ─── Agentic item shopper ──────────────────────────────────────────────────

const SHOPPING_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_instacart",
    description: "Search Instacart for a product. Returns matching products with names, prices, and URLs. If results are empty, try a shorter or different search term. You can also omit store_slug to let Instacart auto-select the best store.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Product search query" },
        store_slug: { type: "string", description: "Store slug to search in (optional, leave empty to auto-detect)" },
      },
      required: ["query"],
    },
  },
  {
    name: "select_product",
    description: "Select the best product you found for this grocery item. Call this once you've found a good match.",
    input_schema: {
      type: "object" as const,
      properties: {
        product_name: { type: "string" },
        price: { type: "number", description: "Price in CAD. Estimate a realistic price if 0." },
        product_url: { type: "string", description: "Product URL from search results" },
        image_url: { type: "string", description: "Product image URL (can be empty)" },
        store: { type: "string", description: "Store name (e.g. Walmart, Loblaws)" },
        reason: { type: "string", description: "Brief reason for your choice" },
      },
      required: ["product_name", "price", "product_url", "store", "reason"],
    },
  },
  {
    name: "mark_not_found",
    description: "Mark this item as not found after trying multiple searches. Only use after at least 2 search attempts.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

async function shopForItem(
  page: Page,
  item: GroceryItem,
  profile: Profile,
  lockedStoreSlug: string,
  lockedStoreName: string
): Promise<{ product: SelectedProduct | null; storeSlug: string; storeName: string }> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `You are a smart grocery shopping assistant. Find the best product on Instacart for:

Item: "${item.name}"
Quantity needed: ${item.quantity}
Budget: $${profile.budget ?? "flexible"} CAD total shop
Dietary: ${profile.dietary?.join(", ") || "none"}
Allergies: ${profile.allergies?.join(", ") || "none"}
Preferred brands: ${profile.brands || "no preference"}
${lockedStoreSlug ? `Store: ${lockedStoreName} (${lockedStoreSlug}) — search here first` : "Store: auto-detect (let Instacart choose)"}

Instructions:
- Use search_instacart to find options
- If 0 results, try a simpler/shorter search term (e.g. "brioche bread" → "brioche", "paper towel" → "paper towels")
- If still 0 results without a store slug, try without store_slug to let Instacart auto-select
- Pick the best value product that matches the item and user preferences
- Use select_product with the chosen product's URL from the results
- Only use mark_not_found if you've genuinely exhausted search options`,
    },
  ];

  let currentStoreSlug = lockedStoreSlug;
  let currentStoreName = lockedStoreName;
  let selectedProduct: SelectedProduct | null = null;
  let isDone = false;

  for (let turn = 0; turn < 6 && !isDone; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: SHOPPING_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "search_instacart") {
        const input = block.input as { query: string; store_slug?: string };
        const slug = input.store_slug || currentStoreSlug || undefined;
        const { results, detectedStoreSlug } = await searchInstacart(page, input.query, slug);

        // Capture store from first successful search
        if (!currentStoreSlug && detectedStoreSlug) {
          currentStoreSlug = detectedStoreSlug;
          currentStoreName = slugToStoreName(detectedStoreSlug);
          console.log(`Store auto-detected: ${currentStoreName}`);
        }

        const resultText = results.length > 0
          ? `Found ${results.length} products at ${currentStoreName || "Instacart"}:\n` +
            results.map((r, i) => `${i + 1}. ${r.name} — $${r.price} CAD\n   URL: ${r.product_url}\n   Image: ${r.image}`).join("\n")
          : `No results for "${input.query}" at ${slug ? slugToStoreName(slug) : "auto-detected store"}. Try a different search term or omit store_slug.`;

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
      }

      else if (block.name === "select_product") {
        const input = block.input as {
          product_name: string; price: number; product_url: string;
          image_url?: string; store: string; reason: string;
        };
        console.log(`✓ "${item.name}" → ${input.product_name} @ $${input.price} (${input.store}) — ${input.reason}`);
        selectedProduct = {
          grocery_item_name: item.name,
          product_name: input.product_name,
          price: input.price,
          image_url: input.image_url ?? "",
          product_url: input.product_url,
          store: input.store,
          swapped: false,
          quantity: item.quantity,
        };
        if (!currentStoreName) currentStoreName = input.store;
        isDone = true;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Product saved." });
      }

      else if (block.name === "mark_not_found") {
        const input = block.input as { reason: string };
        console.log(`✗ "${item.name}" not found — ${input.reason}`);
        // Placeholder so the cart still shows something
        selectedProduct = {
          grocery_item_name: item.name,
          product_name: `Search for "${item.name}"`,
          price: 0,
          image_url: "",
          product_url: currentStoreSlug
            ? `https://www.instacart.ca/store/${currentStoreSlug}/storefront/s?k=${encodeURIComponent(item.name)}`
            : `https://www.instacart.ca/store/s?k=${encodeURIComponent(item.name)}`,
          store: currentStoreName || "Instacart",
          swapped: false,
          quantity: item.quantity,
        };
        isDone = true;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Noted." });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  return { product: selectedProduct, storeSlug: currentStoreSlug, storeName: currentStoreName };
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

  // Only use explicit workflow dispatch store (Shop Now selection), not profile preference
  // Profile preference doesn't work reliably since store-specific search URLs fail in headless Chrome
  let lockedStoreSlug = process.env.STORE_SLUG || "";
  let lockedStoreName = lockedStoreSlug ? slugToStoreName(lockedStoreSlug) : "";
  if (lockedStoreSlug) console.log(`Requested store: ${lockedStoreName}`);

  const selectedProducts: SelectedProduct[] = [];

  for (const item of items) {
    console.log(`\n── Shopping for: ${item.name} ──`);
    const { product, storeSlug, storeName } = await shopForItem(page, item, profile, lockedStoreSlug, lockedStoreName);

    // Lock store after first item
    if (!lockedStoreSlug && storeSlug) {
      lockedStoreSlug = storeSlug;
      lockedStoreName = storeName;
      console.log(`Store locked: ${lockedStoreName}`);
    }

    if (product) selectedProducts.push(product);
    await new Promise((r) => setTimeout(r, 1000));
  }

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
