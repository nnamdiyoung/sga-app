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
  instacart_email: string;
  instacart_password: string;
  instacart_session: string;
  preferred_store_slug?: string;
}

interface GroceryItem {
  name: string;
  quantity: string;
}

interface ProductResult {
  name: string;
  price: number;
  image: string;
  url: string;
  store: string;
  itemId?: string;
  productId?: string;
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

async function saveScreenshot(page: Page, label: string): Promise<void> {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`Screenshot saved: ${file}`);
  } catch { /* non-fatal */ }
}

async function getUsersToShopFor(): Promise<string[]> {
  const forceRun = process.env.FORCE_RUN === "true";
  const { hour, day } = getEasternTime(new Date());
  console.log(`Current ET time: day=${day}, hour=${hour}${forceRun ? " (FORCE_RUN — skipping schedule check)" : ""}`);

  const { data, error } = await supabase
    .from("schedules")
    .select("user_id, days, time")
    .eq("active", true);

  if (error || !data) return [];

  return data
    .filter((s) => {
      if (forceRun) return true;
      const schedHour = parseInt(s.time.split(":")[0]);
      const match = s.days.includes(day) && schedHour === hour;
      console.log(`Schedule check user ${s.user_id}: days=${JSON.stringify(s.days)} time=${s.time} → ${match ? "MATCH" : "skip"}`);
      return match;
    })
    .map((s) => s.user_id);
}

async function loginInstacart(page: Page, email: string, password: string): Promise<boolean> {
  if (!email || !password) {
    console.log("No Instacart credentials, skipping login.");
    return false;
  }

  try {
    console.log("Navigating to Instacart login...");
    await page.goto("https://www.instacart.ca/login", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, "instacart-login-page");
    console.log(`Login page URL: ${page.url()}, title: ${await page.title()}`);

    // Dismiss any cookie / overlay banners first
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("Close")', '[aria-label="Close"]']) {
      try { await page.locator(sel).first().click({ timeout: 2000 }); } catch { /* none present */ }
    }

    // Wait for email field with broad selector list
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
      'input[data-testid*="email" i]',
      'input[id*="email" i]',
    ];

    let filled = false;
    for (const sel of emailSelectors) {
      try {
        await page.locator(sel).first().fill(email, { timeout: 5000 });
        console.log(`Filled email with selector: ${sel}`);
        filled = true;
        break;
      } catch { /* try next */ }
    }

    if (!filled) {
      await saveScreenshot(page, "instacart-login-no-email-field");
      console.log("Could not find email field. HTML:", (await page.content()).substring(0, 500));
      return false;
    }

    // Password
    await page.locator('input[type="password"]').first().fill(password, { timeout: 5000 });
    console.log("Filled password.");
    await saveScreenshot(page, "instacart-before-submit");

    // Submit
    for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
      try { await page.locator(sel).first().click({ timeout: 3000 }); break; } catch { /* try next */ }
    }

    await page.waitForTimeout(5000);
    await saveScreenshot(page, "instacart-after-submit");

    const currentUrl = page.url();
    console.log(`After login URL: ${currentUrl}`);
    const loggedIn = !currentUrl.includes("/login");
    console.log(loggedIn ? "Instacart login successful." : "Login may have failed — continuing anyway.");
    return loggedIn;
  } catch (err) {
    console.log(`Instacart login error: ${err}`);
    await saveScreenshot(page, "instacart-login-error");
    return false;
  }
}

function slugToStoreName(slug: string): string {
  return slug
    .replace(/-(?:on|qc|bc|ab|mb|sk|ns|nb|pe|nl|nt|yt|nu)$/i, "")
    .replace(/-/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function searchInstacart(
  page: Page,
  item: string,
  lockedStoreSlug?: string
): Promise<{ results: ProductResult[]; storeSlug: string; storeName: string }> {
  const results: ProductResult[] = [];
  const fileSlug = item.replace(/\s/g, "_").substring(0, 20);

  function extractPrice(p: any): number {
    const raw =
      p.price ??
      p.unit_price ??
      p.pricing?.price ??
      p.pricing?.unit_price ??
      p.pricing?.display_price ??
      p.attributes?.price ??
      p.displayPrice ??
      p.display_price ??
      0;
    if (!raw) return 0;
    const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  const responseHandler = async (response: any) => {
    const url: string = response.url();
    if (!url.includes("instacart")) return;
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("application/json")) return;
    try {
      const json = await response.json();
      const candidates: any[] =
        json?.items ??
        json?.results ??
        json?.products ??
        json?.data?.items ??
        json?.data?.products ??
        json?.data?.search?.products ??
        json?.modules?.flatMap((m: any) => m.items ?? m.products ?? []) ??
        [];
      if (candidates.length > 0) {
        const first = candidates[0];
        const name = first?.name ?? first?.display_name ?? first?.displayName ?? first?.title;
        console.log(`API ${url.split("?")[0]} — ${candidates.length} candidates, first: name="${name}" keys=${Object.keys(first).slice(0, 8).join(",")}`);
        for (const p of candidates) {
          const pname = p.name ?? p.display_name ?? p.displayName ?? p.title;
          const price = extractPrice(p);
          const image = p.image_url ?? p.image ?? p.photo ?? p.imageUrl ?? "";
          const productUrl = p.url ?? p.product_url ?? p.productUrl ?? "";
          const itemId: string = p.id ?? p.item_id ?? p.itemId ?? "";
          const productId: string = String(p.productId ?? p.legacyId ?? p.legacy_id ?? "");
          if (pname && results.length < 5) {
            results.push({ name: pname, price, image, url: productUrl, store: "Instacart", itemId, productId });
          }
        }
      }
    } catch { /* non-JSON or parse error */ }
  };

  page.on("response", responseHandler);

  let resolvedSlug = lockedStoreSlug ?? "";
  let resolvedName = resolvedSlug ? slugToStoreName(resolvedSlug) : "Instacart";

  try {
    // Use store-specific search URL if we already know the store
    const searchUrl = lockedStoreSlug
      ? `https://www.instacart.ca/store/${lockedStoreSlug}/storefront/s?k=${encodeURIComponent(item)}`
      : `https://www.instacart.ca/store/s?k=${encodeURIComponent(item)}`;
    console.log(`Searching Instacart for "${item}"${lockedStoreSlug ? ` (store: ${lockedStoreSlug})` : ""}`);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(8000);
    await saveScreenshot(page, `instacart-search-${fileSlug}`);

    // Capture store slug from the redirected URL on first search
    if (!lockedStoreSlug) {
      const finalUrl = page.url();
      const match = finalUrl.match(/\/store\/([^/?#]+)/);
      if (match && match[1] !== "s") {
        resolvedSlug = match[1];
        resolvedName = slugToStoreName(resolvedSlug);
        console.log(`Store detected: ${resolvedName} (${resolvedSlug})`);
      }
    }
    console.log(`Instacart search URL: ${page.url()}`);
  } catch (err) {
    console.log(`Instacart navigation error for "${item}": ${err}`);
  }

  page.off("response", responseHandler);
  console.log(`Instacart found ${results.length} results for "${item}"`);
  return { results, storeSlug: resolvedSlug, storeName: resolvedName };
}

async function searchOpenFoodFacts(item: string): Promise<ProductResult[]> {
  // Reliable fallback — no bot detection, works from any IP including GitHub Actions
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(item)}&search_simple=1&action=process&json=1&page_size=8&cc=ca`;
    console.log(`Searching Open Food Facts for "${item}"`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const json: any = await res.json();
    const products: ProductResult[] = [];
    for (const p of (json.products ?? []).slice(0, 5)) {
      const name = p.product_name_en ?? p.product_name ?? p.abbreviated_product_name;
      if (!name?.trim()) continue;
      const brand = p.brands ? ` (${p.brands.split(",")[0].trim()})` : "";
      products.push({
        name: `${name.trim()}${brand}`,
        price: 0,
        image: p.image_small_url ?? p.image_url ?? "",
        url: `https://www.instacart.ca/store/s?k=${encodeURIComponent(name.trim())}`,
        store: "Instacart",
      });
    }
    console.log(`Open Food Facts found ${products.length} results for "${item}"`);
    return products;
  } catch (err) {
    console.log(`Open Food Facts error for "${item}": ${err}`);
    return [];
  }
}

async function addToInstacartCart(page: Page, product: ProductResult, quantity: string): Promise<{ added: boolean; price: number; image: string }> {
  // Parse quantity — take the first integer found, default to 1
  const qty = Math.max(1, parseInt(quantity.match(/\d+/)?.[0] ?? "1", 10) || 1);
  try {
    // Build direct product page URL using productId or numeric suffix of itemId
    let productPageUrl = "";
    if (product.productId) {
      productPageUrl = `https://www.instacart.ca/products/${product.productId}`;
    } else if (product.itemId) {
      const match = product.itemId.match(/(\d+)$/);
      if (match) productPageUrl = `https://www.instacart.ca/products/${match[1]}`;
    } else if (product.url && product.url.startsWith("http") && !product.url.includes("/store/s?")) {
      productPageUrl = product.url;
    }

    if (productPageUrl) {
      console.log(`Navigating to product page: ${productPageUrl}`);
      await page.goto(productPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);
      await saveScreenshot(page, `product-page-${product.name.substring(0, 15).replace(/\s/g, "_")}`);
    }

    // Scrape real price and product image from the product page
    let scrapedPrice = product.price;
    let scrapedImage = product.image;
    try {
      const pageData = await page.evaluate(() => {
        // Price
        let price: number | null = null;
        const priceEls = document.querySelectorAll('[class*="price" i],[data-testid*="price" i],[aria-label*="price" i]');
        for (const el of Array.from(priceEls)) {
          const text = el.textContent?.trim() ?? "";
          const m = text.match(/\$\s*(\d+\.?\d*)/);
          if (m) { price = parseFloat(m[1]); break; }
        }
        // Image — look for the main product image
        let image = "";
        const imgEls = document.querySelectorAll('img[src*="instacart"],img[src*="cloudfront"],img[src*="cdn"]');
        for (const el of Array.from(imgEls) as HTMLImageElement[]) {
          if (el.naturalWidth > 80 && el.src && !el.src.includes("logo")) {
            image = el.src;
            break;
          }
        }
        return { price, image };
      });
      if (pageData.price && pageData.price > 0) {
        scrapedPrice = pageData.price;
        console.log(`Scraped price for "${product.name}": $${scrapedPrice}`);
      }
      if (pageData.image) {
        scrapedImage = pageData.image;
      }
    } catch { /* non-fatal */ }

    // Try multiple selector patterns for the "Add to cart" button
    const addSelectors = [
      '[data-testid="add-item-to-cart-button"]',
      '[data-testid*="add-to-cart"]',
      '[data-testid*="add_to_cart"]',
      'button[aria-label*="Add to cart" i]',
      'button[aria-label*="Add" i]:not([aria-label*="address" i])',
      'button:has-text("Add to cart")',
      'button:has-text("Add item")',
      'button:has-text("Add")',
      '[class*="AddToCart"] button',
      '[class*="add-to-cart"] button',
    ];

    for (const sel of addSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          await page.waitForTimeout(1500);

          // Increase quantity beyond 1 by clicking "+" (qty - 1) more times
          if (qty > 1) {
            const incrementSelectors = [
              '[aria-label*="Increase quantity" i]',
              '[aria-label*="increment" i]',
              '[data-testid*="increment"]',
              'button:has-text("+")',
            ];
            for (let q = 1; q < qty; q++) {
              for (const incSel of incrementSelectors) {
                try {
                  const incBtn = page.locator(incSel).first();
                  if (await incBtn.isVisible({ timeout: 2000 })) {
                    await incBtn.click();
                    await page.waitForTimeout(500);
                    break;
                  }
                } catch { continue; }
              }
            }
            console.log(`Set quantity to ${qty} for "${product.name}"`);
          }

          await saveScreenshot(page, `after-add-${product.name.substring(0, 15).replace(/\s/g, "_")}`);
          console.log(`Added "${product.name}" (qty ${qty}) to Instacart cart`);
          return { added: true, price: scrapedPrice, image: scrapedImage };
        }
      } catch { continue; }
    }

    console.log(`Could not find Add button for "${product.name}"`);
    return { added: false, price: scrapedPrice, image: scrapedImage };
  } catch (err) {
    console.log(`addToInstacartCart error for "${product.name}": ${err}`);
    return { added: false, price: product.price, image: product.image };
  }
}

async function pickBestProduct(
  itemName: string,
  quantity: string,
  options: ProductResult[],
  profile: Profile
): Promise<number> {
  if (options.length === 1) return 0;

  const optionsList = options.map((o, i) => `${i}. ${o.name} — $${o.price} CAD (${o.store})`).join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: `You are a grocery shopping assistant. User preferences:
- Budget: $${profile.budget} CAD per shop
- Dietary: ${profile.dietary?.join(", ") || "none"}
- Allergies: ${profile.allergies?.join(", ") || "none"}
- Preferred brands: ${profile.brands || "none"}
Pick the best product. If price is 0, estimate a realistic Canadian grocery price.
Respond ONLY with JSON: { "index": N, "price": <estimated price if 0 else original>, "reason": "one line" }`,
      messages: [{
        role: "user",
        content: `I need: ${itemName} (qty: ${quantity})\n\nOptions:\n${optionsList}\n\nBest pick?`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{.*?\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const idx = Math.min(parsed.index ?? 0, options.length - 1);
      console.log(`Claude picked index ${idx} for "${itemName}": ${parsed.reason}`);
      // Use Claude's estimated price if original was 0
      if (parsed.price && options[idx].price === 0) {
        options[idx].price = parseFloat(parsed.price);
      }
      return idx;
    }
  } catch (err) {
    console.log(`Claude pick error: ${err}`);
  }

  return 0;
}

async function processUser(userId: string, browser: Browser): Promise<void> {
  const [itemsRes, profileRes] = await Promise.all([
    supabase.from("grocery_items").select("name, quantity").eq("user_id", userId).eq("cleared", false),
    supabase.from("profiles").select("*").eq("user_id", userId).single(),
  ]);

  const items: GroceryItem[] = itemsRes.data ?? [];
  const profile: Profile = profileRes.data;

  if (!items.length) {
    console.log(`No items for user ${userId}, skipping.`);
    return;
  }

  console.log(`Processing ${items.length} items for user ${userId}`);

  const authRes = await supabase.auth.admin.getUserById(userId);
  const userEmail = authRes.data?.user?.email;
  if (!userEmail) return;

  // Parse Instacart session — supports both full storageState (from script) and legacy WebView capture
  type SessionData = {
    storageState?: { cookies: any[]; origins: any[] };
    cookies?: string;
    localStorage?: Record<string, string>;
  };
  let sessionData: SessionData = {};
  if (profile?.instacart_session) {
    try {
      sessionData = JSON.parse(profile.instacart_session);
      console.log("Loaded Instacart session from user profile.");
    } catch {
      console.log("Could not parse instacart_session from profile.");
    }
  } else {
    console.log("No Instacart session in profile — cart additions will fail.");
  }

  // If we have a full Playwright storageState, use it directly — it includes HttpOnly cookies
  const context = sessionData.storageState
    ? await browser.newContext({
        storageState: sessionData.storageState as any,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-CA",
      })
    : await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-CA",
      });

  if (sessionData.storageState) {
    console.log(`Using full storageState: ${sessionData.storageState.cookies.length} cookies (incl. HttpOnly).`);
  } else {
    // Legacy: inject non-HttpOnly cookies + localStorage from WebView capture
    if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
      await context.addInitScript((ls) => {
        for (const [key, value] of Object.entries(ls)) {
          try { localStorage.setItem(key, value as string); } catch {}
        }
      }, sessionData.localStorage);
      console.log(`Injected ${Object.keys(sessionData.localStorage).length} localStorage entries.`);
    }

    if (sessionData.cookies) {
      const parsed = sessionData.cookies.split(';')
        .map(c => {
          const eq = c.indexOf('=');
          if (eq === -1) return null;
          return {
            name: c.substring(0, eq).trim(),
            value: c.substring(eq + 1).trim(),
            domain: '.instacart.ca',
            path: '/',
          };
        })
        .filter((c): c is NonNullable<typeof c> => !!c?.name && !!c?.value);
      if (parsed.length > 0) {
        await context.addCookies(parsed);
        console.log(`Injected ${parsed.length} cookies (legacy WebView capture).`);
      }
    }
  }

  const page = await context.newPage();

  const selectedProducts: SelectedProduct[] = [];
  // Priority: STORE_SLUG env (Shop Now pick) → profile preferred → auto-detect
  let lockedStoreSlug = process.env.STORE_SLUG || profile?.preferred_store_slug || "";
  let lockedStoreName = lockedStoreSlug ? slugToStoreName(lockedStoreSlug) : "Instacart";
  if (lockedStoreSlug) {
    console.log(`Store locked to: ${lockedStoreName} (${lockedStoreSlug})${process.env.STORE_SLUG ? " [from Shop Now]" : " [from profile]"}`);
  }

  for (const item of items) {
    console.log(`\n--- Shopping for: ${item.name} ---`);

    const { results: instacartResults, storeSlug, storeName } = await searchInstacart(page, item.name, lockedStoreSlug || undefined);

    // Lock store after first successful Instacart search
    if (!lockedStoreSlug && storeSlug) {
      lockedStoreSlug = storeSlug;
      lockedStoreName = storeName;
      console.log(`Store locked to: ${lockedStoreName} for all remaining items`);
    }

    let results = instacartResults;

    if (results.length === 0) {
      console.log(`No Instacart results, trying Open Food Facts...`);
      results = await searchOpenFoodFacts(item.name);
    }

    if (results.length === 0) {
      console.log(`No results found for "${item.name}", adding placeholder.`);
      const fallbackUrl = lockedStoreSlug
        ? `https://www.instacart.ca/store/${lockedStoreSlug}/storefront/s?k=${encodeURIComponent(item.name)}`
        : `https://www.instacart.ca/store/s?k=${encodeURIComponent(item.name)}`;
      selectedProducts.push({
        grocery_item_name: item.name,
        product_name: `Search for "${item.name}"`,
        price: 0,
        image_url: "",
        product_url: fallbackUrl,
        store: lockedStoreName,
        swapped: false,
        quantity: item.quantity,
      });
    } else {
      const idx = await pickBestProduct(item.name, item.quantity, results, profile);
      const chosen = results[idx];
      console.log(`Picked: ${chosen.name} @ $${chosen.price} (${lockedStoreName})`);

      // Build store-specific product URL so the app opens the right store context
      let productUrl = chosen.url;
      const numericId = chosen.productId || chosen.itemId.match(/(\d+)$/)?.[1] || "";
      if (lockedStoreSlug && numericId) {
        productUrl = `https://www.instacart.ca/store/${lockedStoreSlug}/product_page/${numericId}`;
      } else if (numericId) {
        productUrl = `https://www.instacart.ca/products/${numericId}`;
      }

      selectedProducts.push({
        grocery_item_name: item.name,
        product_name: chosen.name,
        price: chosen.price,
        image_url: chosen.image,
        product_url: productUrl,
        store: lockedStoreName,
        swapped: false,
        quantity: item.quantity,
      });
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  await context.close();

  const total = selectedProducts.reduce((sum, p) => sum + (p.price ?? 0), 0);

  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .insert({ user_id: userId, status: "pending", total: parseFloat(total.toFixed(2)), platform: "instacart" })
    .select("id")
    .single();

  if (cartError || !cart) throw new Error(`Failed to create cart: ${cartError?.message}`);

  await supabase.from("cart_items").insert(
    selectedProducts.map((p) => ({ cart_id: cart.id, ...p }))
  );

  await supabase.from("grocery_items").update({ cleared: true }).eq("user_id", userId).eq("cleared", false);

  const itemListHtml = selectedProducts
    .map((p) => `<li><strong>${p.grocery_item_name}</strong> → ${p.product_name} ($${p.price.toFixed(2)} CAD)</li>`)
    .join("\n");

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: userEmail,
    subject: `🛒 Your cart is ready — ${selectedProducts.length} items, ~$${total.toFixed(2)} CAD`,
    html: `
      <h2>Your SGA cart is ready!</h2>
      <p><strong>${selectedProducts.length} items</strong>, approximately <strong>$${total.toFixed(2)} CAD</strong>.</p>
      <ul>${itemListHtml}</ul>
      <p>Open the SGA app, go to the Cart tab, and tap <strong>Add to Instacart Cart</strong> — the app will add everything for you. Then just checkout on Instacart.</p>
    `,
  });

  console.log(`\nDone for user ${userId}: ${selectedProducts.length} items, $${total.toFixed(2)} CAD.`);
}

async function main(): Promise<void> {
  console.log("SGA Shopping Agent starting...");

  const userIds = await getUsersToShopFor();
  console.log(`Found ${userIds.length} user(s) to shop for.`);

  if (userIds.length === 0) return;

  const browser = await chromium.launch({ headless: true });

  for (const userId of userIds) {
    try {
      await processUser(userId, browser);
    } catch (err) {
      console.error(`Error for user ${userId}:`, err);
    }
  }

  await browser.close();
  console.log("SGA Shopping Agent done.");
}

main();
