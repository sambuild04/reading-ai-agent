/**
 * Isolated CUA browser agent — runs in its own Chrome profile.
 *
 * Unlike browser-agent.ts (which connects to the user's real Chrome),
 * this agent launches a SEPARATE Chrome instance with its own profile.
 * This means:
 * - It never steals the user's cursor or active tab focus
 * - It runs in its own window (can be minimized/hidden)
 * - It has its own session storage (not logged into user's accounts by default)
 * - The user keeps working uninterrupted while CUA operates
 *
 * The trade-off: no access to the user's existing logins. But for most
 * computer_use tasks (YouTube, search, forms), this is fine.
 * If login is needed, CUA can navigate to the login page visually.
 *
 * Runs as a sidecar process. Receives JSON commands on stdin,
 * returns JSON results on stdout.
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import * as readline from "readline";
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CUA_PROFILE_DIR = join(homedir(), ".samuel", "chrome-cua-profile");
const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;

let browser: Browser | null = null;
let page: Page | null = null;

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

  mkdirSync(CUA_PROFILE_DIR, { recursive: true });

  const chromePath = findChromeExecutable();
  process.stderr.write(`[cua-browser] launching isolated Chrome: ${chromePath}\n`);
  process.stderr.write(`[cua-browser] profile: ${CUA_PROFILE_DIR}\n`);

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    userDataDir: CUA_PROFILE_DIR,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      `--window-size=${VIEWPORT_W},${VIEWPORT_H + 100}`,
      // Position the CUA window off to the side so it doesn't overlap user's work
      "--window-position=50,50",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return browser;
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  const b = await ensureBrowser();
  const pages = await b.pages();
  page = pages[0] ?? await b.newPage();
  return page;
}

async function handleCommand(cmd: { id: string; action: string; [k: string]: unknown }) {
  try {
    switch (cmd.action) {
      case "open": {
        const p = await ensurePage();
        if (cmd.url) {
          await p.goto(cmd.url as string, { waitUntil: "domcontentloaded", timeout: 30000 });
        }
        const title = await p.title();
        reply(cmd.id, true, { title, url: p.url(), message: `Opened: ${title}` });
        break;
      }

      case "cua_screenshot": {
        const p = await ensurePage();
        const buf = await p.screenshot({ type: "png", fullPage: false });
        const base64 = Buffer.from(buf).toString("base64");
        reply(cmd.id, true, {
          base64,
          mimeType: "image/png",
          width: VIEWPORT_W,
          height: VIEWPORT_H,
          title: await p.title(),
          url: p.url(),
        });
        break;
      }

      case "cua_click": {
        const p = await ensurePage();
        const x = cmd.x as number;
        const y = cmd.y as number;
        const modifiers: string[] = (cmd.keys as string[]) ?? [];
        for (const m of modifiers) await p.keyboard.down(modToPuppeteer(m));
        await p.mouse.click(x, y);
        for (const m of modifiers) await p.keyboard.up(modToPuppeteer(m));
        reply(cmd.id, true, { message: `Clicked (${x}, ${y})` });
        break;
      }

      case "cua_double_click": {
        const p = await ensurePage();
        await p.mouse.click(cmd.x as number, cmd.y as number, { clickCount: 2 });
        reply(cmd.id, true, { message: `Double-clicked (${cmd.x}, ${cmd.y})` });
        break;
      }

      case "cua_type": {
        const p = await ensurePage();
        await p.keyboard.type(cmd.text as string);
        reply(cmd.id, true, { message: `Typed ${(cmd.text as string).length} chars` });
        break;
      }

      case "cua_keypress": {
        const p = await ensurePage();
        const keys: string[] = (cmd.keys as string[]) ?? [cmd.key as string];
        for (const k of keys) {
          await p.keyboard.press(normalizeKey(k) as any);
        }
        reply(cmd.id, true, { message: `Pressed keys: ${keys.join("+")}` });
        break;
      }

      case "cua_scroll": {
        const p = await ensurePage();
        const x = (cmd.x as number) ?? 640;
        const y = (cmd.y as number) ?? 450;
        const dx = (cmd.scroll_x as number) ?? 0;
        const dy = (cmd.scroll_y as number) ?? 0;
        await p.mouse.move(x, y);
        await p.mouse.wheel({ deltaX: dx, deltaY: dy });
        reply(cmd.id, true, { message: `Scrolled (${dx}, ${dy}) at (${x}, ${y})` });
        break;
      }

      case "cua_drag": {
        const p = await ensurePage();
        const path: { x: number; y: number }[] = cmd.path as { x: number; y: number }[];
        if (!path || path.length < 2) {
          reply(cmd.id, false, { error: "Drag needs path with at least 2 points" });
          break;
        }
        await p.mouse.move(path[0].x, path[0].y);
        await p.mouse.down();
        for (let i = 1; i < path.length; i++) {
          await p.mouse.move(path[i].x, path[i].y, { steps: 5 });
        }
        await p.mouse.up();
        reply(cmd.id, true, { message: `Dragged ${path.length} points` });
        break;
      }

      case "cua_move": {
        const p = await ensurePage();
        await p.mouse.move(cmd.x as number, cmd.y as number);
        reply(cmd.id, true, { message: `Moved to (${cmd.x}, ${cmd.y})` });
        break;
      }

      case "cua_wait": {
        await new Promise((r) => setTimeout(r, Math.min((cmd.ms as number) ?? 2000, 15000)));
        reply(cmd.id, true, { message: "Wait complete" });
        break;
      }

      case "close": {
        if (browser) {
          await browser.close();
          browser = null;
          page = null;
        }
        reply(cmd.id, true, { message: "CUA browser closed" });
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

process.stderr.write("[cua-browser] ready\n");
