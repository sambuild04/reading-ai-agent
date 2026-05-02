/**
 * Browser automation agent — connects to the user's real Chrome.
 *
 * Uses puppeteer-core to attach to Chrome via the DevTools Protocol.
 * No separate Chromium download needed — operates the user's actual browser
 * with their existing sessions, cookies, and logins.
 *
 * Runs as a sidecar process. Receives JSON commands on stdin,
 * returns JSON results on stdout.
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import * as readline from "readline";
import { execSync } from "child_process";

let browser: Browser | null = null;
const pages = new Map<number, Page>();
let nextTabId = 1;
let activeTabId = 0;

function reply(id: string, ok: boolean, data: unknown) {
  const msg = JSON.stringify({ id, ok, data });
  process.stdout.write(msg + "\n");
}

function findChromeExecutable(): string {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of candidates) {
    try {
      execSync(`test -f "${p}"`, { stdio: "ignore" });
      return p;
    } catch { /* not found */ }
  }
  return candidates[0];
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;

  // Try connecting to an already-running Chrome with debug port
  try {
    browser = await puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    });
    process.stderr.write("[browser-agent] connected to existing Chrome on :9222\n");
    return browser;
  } catch {
    // No debuggable Chrome running — launch one
  }

  const chromePath = findChromeExecutable();

  // Strategy: connect to the user's ALREADY-RUNNING Chrome by enabling remote debugging.
  // On macOS, we can relaunch Chrome with the debug flag — it will reuse the existing instance.
  try {
    execSync(
      `open -a "Google Chrome" --args --remote-debugging-port=9222`,
      { stdio: "ignore", timeout: 5000 }
    );
    // Give Chrome a moment to enable the debug port
    await new Promise(r => setTimeout(r, 2000));
    browser = await puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    });
    process.stderr.write("[browser-agent] connected to user's Chrome via remote debugging\n");
    return browser;
  } catch (e) {
    process.stderr.write(`[browser-agent] could not connect to user's Chrome: ${e}\n`);
  }

  // Final fallback: launch a fresh Chrome (won't have user's logins)
  process.stderr.write(`[browser-agent] launching fresh Chrome: ${chromePath}\n`);

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: null,
    userDataDir: undefined,
    args: [
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return browser;
}

async function getActivePage(): Promise<Page> {
  const page = pages.get(activeTabId);
  if (!page) throw new Error("No active tab. Use 'open' or 'goto' first.");
  return page;
}

async function newTab(url?: string): Promise<{ tabId: number; page: Page }> {
  const b = await ensureBrowser();
  const page = await b.newPage();
  const tabId = nextTabId++;
  pages.set(tabId, page);
  activeTabId = tabId;

  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  return { tabId, page };
}

async function extractText(page: Page, selector?: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.body;
    if (!el) return "(element not found)";

    const clone = el.cloneNode(true) as HTMLElement;
    for (const tag of ["script", "style", "nav", "header", "footer", "iframe", "noscript"]) {
      clone.querySelectorAll(tag).forEach((n) => n.remove());
    }

    const text = clone.innerText || clone.textContent || "";
    return text
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .join("\n")
      .slice(0, 15000);
  }, selector);
}

async function extractStructure(page: Page): Promise<string> {
  return page.evaluate(() => {
    const items: string[] = [];

    const clickable = document.querySelectorAll("a[href], button, [role='button'], input[type='submit']");
    const seen = new Set<string>();
    clickable.forEach((el, i) => {
      const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || "";
      const href = (el as HTMLAnchorElement).href || "";
      const tag = el.tagName.toLowerCase();
      const key = `${tag}:${text}:${href}`;
      if (seen.has(key) || (!text && !href)) return;
      seen.add(key);
      if (items.length < 40) {
        items.push(`[${i}] <${tag}> "${text}"${href ? ` → ${href}` : ""}`);
      }
    });

    const inputs = document.querySelectorAll("input:not([type='hidden']), textarea, select");
    inputs.forEach((el) => {
      const inp = el as HTMLInputElement;
      const label =
        inp.getAttribute("aria-label") ||
        inp.getAttribute("placeholder") ||
        inp.getAttribute("name") ||
        inp.type;
      items.push(`[input] <${inp.tagName.toLowerCase()} type="${inp.type || "text"}"> "${label}"`);
    });

    return items.join("\n").slice(0, 8000);
  });
}

async function handleCommand(cmd: { id: string; action: string; [k: string]: unknown }) {
  try {
    switch (cmd.action) {
      case "open": {
        const { tabId, page } = await newTab(cmd.url as string | undefined);
        const title = await page.title();
        const url = page.url();
        reply(cmd.id, true, { tabId, title, url, message: `Opened tab #${tabId}: ${title}` });
        break;
      }

      case "goto": {
        const page = await getActivePage();
        await page.goto(cmd.url as string, { waitUntil: "domcontentloaded", timeout: 30000 });
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), message: `Navigated to: ${title}` });
        break;
      }

      case "read_page": {
        const page = await getActivePage();
        const text = await extractText(page, cmd.selector as string | undefined);
        const title = await page.title();
        const url = page.url();
        reply(cmd.id, true, { title, url, text, length: text.length });
        break;
      }

      case "read_structure": {
        const page = await getActivePage();
        const structure = await extractStructure(page);
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), structure });
        break;
      }

      case "click": {
        const page = await getActivePage();
        const sel = cmd.selector as string;
        if (cmd.text) {
          const text = cmd.text as string;
          const elements = await page.$$("a, button, [role='button'], span, div, li, td");
          let clicked = false;
          for (const el of elements) {
            const elText = await el.evaluate((e) => (e as HTMLElement).innerText?.trim() ?? "");
            if (elText.includes(text)) {
              await el.click();
              clicked = true;
              break;
            }
          }
          if (!clicked) throw new Error(`No element with text "${text}" found`);
        } else if (sel) {
          await page.click(sel);
        } else {
          throw new Error("Need 'selector' or 'text' to click");
        }
        await new Promise((r) => setTimeout(r, 1000));
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), message: `Clicked. Now on: ${title}` });
        break;
      }

      case "type": {
        const page = await getActivePage();
        const sel = (cmd.selector as string) || "input:focus, textarea:focus, [contenteditable]:focus";
        await page.click(sel);
        await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLInputElement;
          if (el) el.value = "";
        }, sel);
        await page.type(sel, cmd.text as string);
        reply(cmd.id, true, { message: `Typed into ${sel}` });
        break;
      }

      case "press": {
        const page = await getActivePage();
        await page.keyboard.press(cmd.key as string as any);
        await new Promise((r) => setTimeout(r, 500));
        reply(cmd.id, true, { message: `Pressed ${cmd.key}` });
        break;
      }

      case "screenshot": {
        const page = await getActivePage();
        const buf = await page.screenshot({ type: "jpeg", quality: 70 });
        const base64 = Buffer.from(buf).toString("base64");
        reply(cmd.id, true, { base64, mimeType: "image/jpeg", title: await page.title() });
        break;
      }

      case "scroll": {
        const page = await getActivePage();
        const dir = (cmd.direction as string) || "down";
        const px = (cmd.pixels as number) || 600;
        await page.evaluate(
          ({ dir, px }) => window.scrollBy(0, dir === "up" ? -px : px),
          { dir, px },
        );
        reply(cmd.id, true, { message: `Scrolled ${dir} ${px}px` });
        break;
      }

      case "wait": {
        await new Promise((r) => setTimeout(r, Math.min((cmd.ms as number) || 2000, 10000)));
        reply(cmd.id, true, { message: `Waited ${cmd.ms ?? 2000}ms` });
        break;
      }

      case "list_tabs": {
        const tabs: { id: number; title: string; url: string; active: boolean }[] = [];
        for (const [id, page] of pages) {
          tabs.push({ id, title: await page.title(), url: page.url(), active: id === activeTabId });
        }
        reply(cmd.id, true, { tabs });
        break;
      }

      case "switch_tab": {
        const tabId = cmd.tabId as number;
        if (!pages.has(tabId)) throw new Error(`Tab #${tabId} not found`);
        activeTabId = tabId;
        const page = pages.get(tabId)!;
        await page.bringToFront();
        reply(cmd.id, true, { tabId, title: await page.title(), url: page.url() });
        break;
      }

      case "close_tab": {
        const tabId = (cmd.tabId as number) || activeTabId;
        const page = pages.get(tabId);
        if (page) {
          await page.close();
          pages.delete(tabId);
          if (activeTabId === tabId) {
            activeTabId = pages.keys().next().value ?? 0;
          }
        }
        reply(cmd.id, true, { message: `Closed tab #${tabId}`, remaining: pages.size });
        break;
      }

      // ── CUA (Computer Use Agent) actions ──────────────────────────────

      case "cua_screenshot": {
        const page = await getActivePage();
        const buf = await page.screenshot({ type: "png", fullPage: false });
        const base64 = Buffer.from(buf).toString("base64");
        const vp = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        reply(cmd.id, true, {
          base64,
          mimeType: "image/png",
          width: vp.width,
          height: vp.height,
          title: await page.title(),
          url: page.url(),
        });
        break;
      }

      case "cua_click": {
        const page = await getActivePage();
        const x = cmd.x as number;
        const y = cmd.y as number;
        const modifiers: string[] = (cmd.keys as string[]) ?? [];
        for (const m of modifiers) await page.keyboard.down(modToPuppeteer(m));
        await page.mouse.click(x, y);
        for (const m of modifiers) await page.keyboard.up(modToPuppeteer(m));
        reply(cmd.id, true, { message: `Clicked (${x}, ${y})` });
        break;
      }

      case "cua_double_click": {
        const page = await getActivePage();
        await page.mouse.click(cmd.x as number, cmd.y as number, { clickCount: 2 });
        reply(cmd.id, true, { message: `Double-clicked (${cmd.x}, ${cmd.y})` });
        break;
      }

      case "cua_type": {
        const page = await getActivePage();
        await page.keyboard.type(cmd.text as string);
        reply(cmd.id, true, { message: `Typed ${(cmd.text as string).length} chars` });
        break;
      }

      case "cua_keypress": {
        const page = await getActivePage();
        const keys: string[] = (cmd.keys as string[]) ?? [cmd.key as string];
        for (const k of keys) {
          await page.keyboard.press(normalizeKey(k) as any);
        }
        reply(cmd.id, true, { message: `Pressed keys: ${keys.join("+")}` });
        break;
      }

      case "cua_scroll": {
        const page = await getActivePage();
        const x = (cmd.x as number) ?? 640;
        const y = (cmd.y as number) ?? 450;
        const dx = (cmd.scroll_x as number) ?? 0;
        const dy = (cmd.scroll_y as number) ?? 0;
        await page.mouse.move(x, y);
        await page.mouse.wheel({ deltaX: dx, deltaY: dy });
        reply(cmd.id, true, { message: `Scrolled (${dx}, ${dy}) at (${x}, ${y})` });
        break;
      }

      case "cua_drag": {
        const page = await getActivePage();
        const path: { x: number; y: number }[] = cmd.path as { x: number; y: number }[];
        if (!path || path.length < 2) {
          reply(cmd.id, false, { error: "Drag needs path with at least 2 points" });
          break;
        }
        await page.mouse.move(path[0].x, path[0].y);
        await page.mouse.down();
        for (let i = 1; i < path.length; i++) {
          await page.mouse.move(path[i].x, path[i].y, { steps: 5 });
        }
        await page.mouse.up();
        reply(cmd.id, true, { message: `Dragged ${path.length} points` });
        break;
      }

      case "cua_move": {
        const page = await getActivePage();
        await page.mouse.move(cmd.x as number, cmd.y as number);
        reply(cmd.id, true, { message: `Moved to (${cmd.x}, ${cmd.y})` });
        break;
      }

      case "cua_wait": {
        await new Promise((r) => setTimeout(r, Math.min((cmd.ms as number) ?? 2000, 15000)));
        reply(cmd.id, true, { message: "Wait complete" });
        break;
      }

      case "close": {
        // Only close pages we opened, don't kill the user's browser
        for (const [, page] of pages) {
          await page.close().catch(() => {});
        }
        pages.clear();
        if (browser) {
          browser.disconnect();
          browser = null;
        }
        reply(cmd.id, true, { message: "Disconnected from browser" });
        process.exit(0);
        break;
      }

      default:
        reply(cmd.id, false, { error: `Unknown action: ${cmd.action}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply(cmd.id, false, { error: msg });
  }
}

function modToPuppeteer(key: string): any {
  const m: Record<string, string> = {
    CTRL: "Control", CONTROL: "Control",
    ALT: "Alt", OPTION: "Alt",
    SHIFT: "Shift",
    META: "Meta", CMD: "Meta", COMMAND: "Meta",
  };
  return m[key.toUpperCase()] ?? key;
}

function normalizeKey(key: string): string {
  const m: Record<string, string> = {
    ENTER: "Enter", RETURN: "Enter",
    TAB: "Tab", ESCAPE: "Escape", ESC: "Escape",
    BACKSPACE: "Backspace", DELETE: "Delete",
    SPACE: " ",
    ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown",
    ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight",
    CTRL: "Control", ALT: "Alt", SHIFT: "Shift", META: "Meta",
    HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown",
  };
  return m[key.toUpperCase()] ?? key;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const cmd = JSON.parse(line.trim());
    if (cmd.action) handleCommand(cmd);
  } catch {
    // Ignore malformed lines
  }
});

process.stderr.write("[browser-agent] ready\n");
