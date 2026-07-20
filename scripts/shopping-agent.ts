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
}

interface SelectedProduct {
  grocery_item_name: string;
  product_name: string;
  price: number;
  image_url: string;
  product_url: string;
  store: string;
  swapped: boolean;
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
  const { hour, day } = getEasternTime(new Date());
  console.log(`Current ET time: day=${day}, hour=${hour}`);

  const { data, error } = await supabase
    .from("schedules")
    .select("user_id, days, time")
    .eq("active", true);

  if (error || !data) return [];

  return data
    .filter((s) => {
      const schedHour = parseInt(s.time.split(":")[0]);
      const match = s.days.includes(day) && schedHour === hour;
      console.log(`Schedule check user ${s.user_id}: days=${JSON.stringify(s.days)} time=${s.time} → ${match ? "MATCH" : "skip"}`);
      return match;
    })
    .map((s) => s.user_id);
}

async function loginInstacart(page: Page, email: string, password: string): Promise<boolean> {
  if (!email || !password) {
    console.log("No Instacart credentials provided, skipping login.");
    return false;
  }

  try {
    console.log("Navigating to Instacart login...");
    await page.goto("https://www.instacart.ca/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, "instacart-login-page");

    console.log(`Login page URL: ${page.url()}, title: ${await page.title()}`);

    // Fill email
    const emailField = page.locator('input[type="email"], input[name="email"], input[id*="email"]').first();
    await emailField.waitFor({ timeout: 10000 });
    await emailField.fill(email);
    console.log("Filled email.");

    // Fill password
    const passwordField = page.locator('input[type="password"], input[name="password"]').first();
    await passwordField.fill(password);
    console.log("Filled password.");

    await saveScreenshot(page, "instacart-before-submit");

    // Submit
    const submitBtn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').first();
    await submitBtn.click();
    await page.waitForTimeout(4000);
    await saveScreenshot(page, "instacart-after-submit");

    const currentUrl = page.url();
    console.log(`After login URL: ${currentUrl}`);

    const loggedIn = !currentUrl.includes("/login");
    console.log(loggedIn ? "Instacart login successful." : "Instacart login may have failed.");
    return loggedIn;
  } catch (err) {
    console.log(`Instacart login error: ${err}`);
    await saveScreenshot(page, "instacart-login-error");
    return false;
  }
}

async function searchInstacart(page: Page, item: string): Promise<ProductResult[]> {
  try {
    const url = `https://www.instacart.ca/store/s?k=${encodeURIComponent(item)}`;
    console.log(`Searching Instacart for "${item}": ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await saveScreenshot(page, `instacart-search-${item.replace(/\s/g, "_")}`);

    console.log(`Search page URL: ${page.url()}, title: ${await page.title()}`);

    const results = await page.evaluate(() => {
      const found: { name: string; price: number; image: string; url: string }[] = [];

      // Try multiple selector strategies
      const selectors = [
        '[data-testid="item-card"]',
        '[data-testid="product-card"]',
        '[class*="ItemCard"]',
        '[class*="ProductCard"]',
        'li[class*="item"]',
        'article',
      ];

      let cards: NodeListOf<Element> | null = null;
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          cards = els;
          console.log(`Found ${els.length} cards with selector: ${sel}`);
          break;
        }
      }

      if (!cards || cards.length === 0) return found;

      cards.forEach((card) => {
        // Try to extract name
        const nameEl =
          card.querySelector('[data-testid="item-name"]') ??
          card.querySelector('[class*="name"]') ??
          card.querySelector('span[aria-label]') ??
          card.querySelector('p') ??
          card.querySelector('span');

        // Try to extract price
        const priceEl =
          card.querySelector('[data-testid="item-price"]') ??
          card.querySelector('[class*="price"]') ??
          card.querySelector('[aria-label*="$"]');

        const imgEl = card.querySelector("img");
        const linkEl = card.querySelector("a");

        const name = nameEl?.textContent?.trim();
        const priceText = priceEl?.textContent ?? card.textContent ?? "";
        const priceMatch = priceText.match(/\$?([\d]+\.[\d]{2})/);

        if (name && priceMatch) {
          found.push({
            name,
            price: parseFloat(priceMatch[1]),
            image: imgEl?.src ?? "",
            url: linkEl?.href ?? "",
          });
        }
      });

      return found.slice(0, 5);
    });

    console.log(`Instacart found ${results.length} results for "${item}"`);

    if (results.length === 0) {
      // Log a snippet of the HTML to help debug selectors
      const htmlSnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 1000));
      console.log(`HTML snippet (first 1000 chars): ${htmlSnippet}`);
    }

    return results.map((r) => ({ ...r, store: "Instacart" }));
  } catch (err) {
    console.log(`Instacart search error for "${item}": ${err}`);
    await saveScreenshot(page, `instacart-error-${item.replace(/\s/g, "_")}`);
    return [];
  }
}

async function searchWalmart(page: Page, item: string): Promise<ProductResult[]> {
  try {
    const url = `https://www.walmart.ca/search?q=${encodeURIComponent(item)}`;
    console.log(`Searching Walmart for "${item}": ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await saveScreenshot(page, `walmart-search-${item.replace(/\s/g, "_")}`);

    console.log(`Walmart page URL: ${page.url()}, title: ${await page.title()}`);

    const results = await page.evaluate(() => {
      const found: { name: string; price: number; image: string; url: string }[] = [];

      const selectors = [
        '[data-automation="search-result-listitem"]',
        '[data-item-id]',
        '[class*="ProductTile"]',
        '[class*="product-tile"]',
        'li[class*="search"]',
        'article',
      ];

      let cards: NodeListOf<Element> | null = null;
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          cards = els;
          break;
        }
      }

      if (!cards || cards.length === 0) return found;

      cards.forEach((card) => {
        const nameEl =
          card.querySelector('[data-automation="product-title"]') ??
          card.querySelector('[class*="product-title"]') ??
          card.querySelector('[class*="ProductTitle"]') ??
          card.querySelector('a[aria-label]') ??
          card.querySelector('span[aria-label]');

        const priceEl =
          card.querySelector('[data-automation="buybox-price"]') ??
          card.querySelector('[class*="price-characteristic"]') ??
          card.querySelector('[class*="Price"]') ??
          card.querySelector('[class*="price"]');

        const imgEl = card.querySelector("img");
        const linkEl = card.querySelector("a");

        const name =
          nameEl?.textContent?.trim() ??
          nameEl?.getAttribute("aria-label") ??
          linkEl?.getAttribute("aria-label");

        const priceText = priceEl?.textContent ?? card.textContent ?? "";
        const priceMatch = priceText.match(/\$?([\d]+\.[\d]{2})/);

        if (name && priceMatch) {
          found.push({
            name,
            price: parseFloat(priceMatch[1]),
            image: imgEl?.src ?? "",
            url: linkEl?.href ?? "",
          });
        }
      });

      return found.slice(0, 5);
    });

    console.log(`Walmart found ${results.length} results for "${item}"`);

    if (results.length === 0) {
      const htmlSnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 1000));
      console.log(`Walmart HTML snippet: ${htmlSnippet}`);
    }

    return results.map((r) => ({ ...r, store: "Walmart" }));
  } catch (err) {
    console.log(`Walmart search error for "${item}": ${err}`);
    return [];
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
Respond ONLY with JSON: { "index": N, "reason": "one line" }`,
      messages: [{
        role: "user",
        content: `I need: ${itemName} (qty: ${quantity})\n\nOptions:\n${optionsList}\n\nBest pick?`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{.*?\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      console.log(`Claude picked index ${parsed.index} for "${itemName}": ${parsed.reason}`);
      return Math.min(parsed.index ?? 0, options.length - 1);
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

  // Create a single browser context and page for this user
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-CA",
  });
  const page = await context.newPage();

  // Log in to Instacart first
  const instacartLoggedIn = await loginInstacart(page, profile?.instacart_email, profile?.instacart_password);

  const selectedProducts: SelectedProduct[] = [];

  for (const item of items) {
    console.log(`\n--- Shopping for: ${item.name} ---`);

    let results: ProductResult[] = [];

    // Try Instacart first (preferably logged in)
    results = await searchInstacart(page, item.name);

    // Fall back to Walmart if Instacart yields nothing
    if (results.length === 0) {
      console.log(`No Instacart results, trying Walmart...`);
      results = await searchWalmart(page, item.name);
    }

    if (results.length === 0) {
      console.log(`No results found for "${item.name}", adding placeholder.`);
      selectedProducts.push({
        grocery_item_name: item.name,
        product_name: `Search for "${item.name}"`,
        price: 0,
        image_url: "",
        product_url: `https://www.instacart.ca/store/s?k=${encodeURIComponent(item.name)}`,
        store: "Instacart",
        swapped: false,
      });
    } else {
      const idx = await pickBestProduct(item.name, item.quantity, results, profile);
      const chosen = results[idx];
      console.log(`Picked: ${chosen.name} @ $${chosen.price} (${chosen.store})`);
      selectedProducts.push({
        grocery_item_name: item.name,
        product_name: chosen.name,
        price: chosen.price,
        image_url: chosen.image,
        product_url: chosen.url,
        store: chosen.store,
        swapped: false,
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
    subject: `🛒 Your SGA cart is ready — ${selectedProducts.length} items, ~$${total.toFixed(2)} CAD`,
    html: `
      <h2>Your SGA cart is ready!</h2>
      <p><strong>${selectedProducts.length} items</strong>, approximately <strong>$${total.toFixed(2)} CAD</strong>.</p>
      <ul>${itemListHtml}</ul>
      <p>Open the SGA app to review and checkout.</p>
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
