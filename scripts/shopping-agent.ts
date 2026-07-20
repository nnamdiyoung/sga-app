import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { Resend } from "resend";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const resend = new Resend(process.env.RESEND_API_KEY!);

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
  // DST starts second Sunday of March, ends first Sunday of November
  const marchStart = new Date(Date.UTC(year, 2, 1));
  const marchDay = marchStart.getUTCDay();
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - marchDay) % 7, 7));
  const novStart = new Date(Date.UTC(year, 10, 1));
  const novDay = novStart.getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - novDay) % 7, 6));
  return date >= dstStart && date < dstEnd;
}

function getEasternHour(date: Date): number {
  const offsetHours = isEasternDST(date) ? -4 : -5;
  const utcHours = date.getUTCHours();
  return ((utcHours + offsetHours) + 24) % 24;
}

function getEasternDay(date: Date): number {
  const offsetHours = isEasternDST(date) ? -4 : -5;
  const utcMs = date.getTime();
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  return new Date(etMs).getUTCDay();
}

async function getUsersToShopFor(): Promise<string[]> {
  const now = new Date();
  const etHour = getEasternHour(now);
  const etDay = getEasternDay(now);

  const { data: schedules, error } = await supabase
    .from("schedules")
    .select("user_id, days, time")
    .eq("active", true);

  if (error || !schedules) return [];

  return schedules
    .filter((s) => {
      if (!s.days.includes(etDay)) return false;
      const [schedHour] = s.time.split(":").map(Number);
      return schedHour === etHour;
    })
    .map((s) => s.user_id);
}

async function scrapeWalmart(item: string): Promise<ProductResult[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(
      `https://www.walmart.ca/search?q=${encodeURIComponent(item)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForTimeout(2000);

    const results = await page.evaluate(() => {
      const items = document.querySelectorAll(
        '[data-automation="search-result-listitem"]'
      );
      const found: { name: string; price: number; image: string; url: string }[] = [];
      items.forEach((el) => {
        const nameEl = el.querySelector('[data-automation="product-title"]');
        const priceEl = el.querySelector('[data-automation="product-price"]');
        const imgEl = el.querySelector("img");
        const linkEl = el.querySelector("a");
        if (!nameEl || !priceEl) return;
        const priceText = priceEl.textContent ?? "";
        const priceMatch = priceText.match(/[\d.]+/);
        if (!priceMatch) return;
        found.push({
          name: nameEl.textContent?.trim() ?? "",
          price: parseFloat(priceMatch[0]),
          image: imgEl?.src ?? "",
          url: linkEl?.href ?? "",
        });
      });
      return found.slice(0, 5);
    });

    await browser.close();
    return results.map((r) => ({ ...r, store: "Walmart" }));
  } catch {
    await browser.close().catch(() => {});
    return [];
  }
}

async function scrapeInstacart(item: string): Promise<ProductResult[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(
      `https://www.instacart.ca/store/s?k=${encodeURIComponent(item)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForTimeout(2000);

    const results = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid="item-card"]');
      const found: { name: string; price: number; image: string; url: string }[] = [];
      items.forEach((el) => {
        const nameEl = el.querySelector('[data-testid="item-name"]');
        const priceEl = el.querySelector('[data-testid="item-price"]');
        const imgEl = el.querySelector("img");
        const linkEl = el.querySelector("a");
        if (!nameEl || !priceEl) return;
        const priceText = priceEl.textContent ?? "";
        const priceMatch = priceText.match(/[\d.]+/);
        if (!priceMatch) return;
        found.push({
          name: nameEl.textContent?.trim() ?? "",
          price: parseFloat(priceMatch[0]),
          image: imgEl?.src ?? "",
          url: linkEl?.href ?? "",
        });
      });
      return found.slice(0, 5);
    });

    await browser.close();
    return results.map((r) => ({ ...r, store: "Instacart" }));
  } catch {
    await browser.close().catch(() => {});
    return [];
  }
}

async function pickBestProduct(
  itemName: string,
  quantity: string,
  options: ProductResult[],
  profile: Profile
): Promise<{ index: number; reason: string }> {
  const dietary = profile.dietary?.join(", ") || "none";
  const allergies = profile.allergies?.join(", ") || "none";

  const optionsList = options
    .map((o, i) => `${i}. ${o.name} — $${o.price} CAD (${o.store})`)
    .join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: `You are a grocery shopping assistant. The user has the following preferences:
- Budget: $${profile.budget} CAD per shop
- Dietary restrictions: ${dietary}
- Allergies: ${allergies}
- Preferred brands: ${profile.brands || "none"}

Pick the best matching product for the user. Avoid anything that conflicts with their dietary restrictions or allergies. Prefer their preferred brands when available. Respond ONLY with JSON in this exact format: { "index": N, "reason": "one line" }`,
      messages: [
        {
          role: "user",
          content: `I need to buy: ${itemName} (quantity: ${quantity})\n\nOptions:\n${optionsList}\n\nWhich option is best?`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{.*\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { index: parsed.index ?? 0, reason: parsed.reason ?? "" };
    }
  } catch {
    // fall through to default
  }

  return { index: 0, reason: "defaulted to first result" };
}

async function processUser(userId: string): Promise<void> {
  const [itemsRes, profileRes] = await Promise.all([
    supabase
      .from("grocery_items")
      .select("name, quantity")
      .eq("user_id", userId)
      .eq("cleared", false),
    supabase.from("profiles").select("*").eq("user_id", userId).single(),
  ]);

  const items: GroceryItem[] = itemsRes.data ?? [];
  const profile: Profile = profileRes.data;

  if (!items.length) {
    console.log(`No items for user ${userId}, skipping.`);
    return;
  }

  const authRes = await supabase.auth.admin.getUserById(userId);
  const userEmail = authRes.data?.user?.email;
  if (!userEmail) {
    console.log(`No email for user ${userId}, skipping.`);
    return;
  }

  const selectedProducts: SelectedProduct[] = [];

  for (const item of items) {
    let results = await scrapeWalmart(item.name);

    if (results.length === 0) {
      results = await scrapeInstacart(item.name);
    }

    if (results.length === 0) {
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
      const { index } = await pickBestProduct(
        item.name,
        item.quantity,
        results,
        profile
      );
      const chosen = results[Math.min(index, results.length - 1)];
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

  const total = selectedProducts.reduce((sum, p) => sum + (p.price ?? 0), 0);

  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .insert({
      user_id: userId,
      status: "pending",
      total: parseFloat(total.toFixed(2)),
      platform: "multi",
    })
    .select("id")
    .single();

  if (cartError || !cart) {
    throw new Error(`Failed to create cart: ${cartError?.message}`);
  }

  const cartItemRows = selectedProducts.map((p) => ({
    cart_id: cart.id,
    grocery_item_name: p.grocery_item_name,
    product_name: p.product_name,
    price: p.price,
    image_url: p.image_url,
    product_url: p.product_url,
    store: p.store,
    swapped: p.swapped,
  }));

  await supabase.from("cart_items").insert(cartItemRows);

  const itemListHtml = selectedProducts
    .map(
      (p) =>
        `<li><strong>${p.grocery_item_name}</strong> → ${p.product_name} ($${p.price.toFixed(2)} CAD)</li>`
    )
    .join("\n");

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: userEmail,
    subject: `🛒 Your SGA cart is ready — ${selectedProducts.length} items, ~$${total.toFixed(2)} CAD`,
    html: `
      <h2>Your SGA cart is ready!</h2>
      <p>We found <strong>${selectedProducts.length} items</strong> totalling approximately <strong>$${total.toFixed(2)} CAD</strong>.</p>
      <ul>
        ${itemListHtml}
      </ul>
      <p>Open the SGA app to review your cart and checkout.</p>
    `,
  });

  console.log(
    `Done for user ${userId}: ${selectedProducts.length} items, $${total.toFixed(2)} CAD. Email sent to ${userEmail}.`
  );
}

async function main(): Promise<void> {
  console.log("SGA Shopping Agent starting...");

  const userIds = await getUsersToShopFor();
  console.log(`Found ${userIds.length} user(s) to shop for.`);

  for (const userId of userIds) {
    try {
      await processUser(userId);
    } catch (err) {
      console.error(`Error processing user ${userId}:`, err);
    }
  }

  console.log("SGA Shopping Agent done.");
}

main();
