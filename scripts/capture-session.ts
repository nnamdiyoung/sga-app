import { chromium } from "playwright";
import * as fs from "fs";

async function main() {
  console.log("Opening Instacart in a visible browser...");
  console.log("Log in manually (including Google), then close the browser.\n");

  const browser = await chromium.launch({
    headless: false, // visible browser so you can log in manually
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://www.instacart.ca/login");

  console.log("Waiting for you to log in... (you have 3 minutes)");
  console.log("Once logged in and you can see the Instacart homepage, press Enter here.");

  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // Save session state (cookies + localStorage)
  const state = await context.storageState();
  const stateJson = JSON.stringify(state);
  const stateB64 = Buffer.from(stateJson).toString("base64");

  fs.writeFileSync("instacart-session.json", stateJson);
  fs.writeFileSync("instacart-session.b64", stateB64);

  console.log("\nSession captured!");
  console.log("instacart-session.json — saved locally");
  console.log("\nNext step:");
  console.log("Copy the contents of instacart-session.b64 and add it as a GitHub secret named INSTACART_SESSION\n");

  await browser.close();
}

main().catch(console.error);
