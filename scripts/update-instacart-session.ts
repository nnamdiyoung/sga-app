import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as readline from "readline";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const USER_EMAIL = process.env.USER_EMAIL!;

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  if (!USER_EMAIL) {
    console.error("Set USER_EMAIL environment variable to your account email.");
    process.exit(1);
  }

  console.log("Opening Instacart in a visible browser...");
  console.log("Log in with Google, wait for the homepage to fully load, then press Enter.\n");

  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://www.instacart.ca/login");

  await prompt("Log in, then press Enter once you can see your address / store on Instacart: ");

  // storageState captures ALL cookies including HttpOnly — this is the key difference
  const state = await context.storageState();

  await browser.close();

  // Look up the user's profile
  const authRes = await supabase.auth.admin.listUsers();
  const user = authRes.data?.users?.find((u) => u.email === USER_EMAIL);
  if (!user) {
    console.error(`No user found with email ${USER_EMAIL}`);
    process.exit(1);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .single();

  if (!profile) {
    console.error("No profile found for this user. Make sure they have logged into the app at least once.");
    process.exit(1);
  }

  // Save full storageState (includes HttpOnly cookies) as instacart_session
  const sessionJson = JSON.stringify({
    storageState: state,
  });

  const { error } = await supabase
    .from("profiles")
    .update({ instacart_session: sessionJson })
    .eq("id", profile.id);

  if (error) {
    console.error("Failed to save session:", error.message);
    process.exit(1);
  }

  console.log(`\nSession saved for ${USER_EMAIL}!`);
  console.log(`Captured ${state.cookies.length} cookies and ${state.origins.length} origin(s) of localStorage.`);
  console.log("The shopping agent will use this session on the next run.\n");
}

main().catch(console.error);
