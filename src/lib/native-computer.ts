/**
 * Native macOS Computer interface — implements @openai/agents `Computer` type.
 *
 * Uses CGEvent (via Swift helper) for mouse/keyboard input and screencapture for screenshots.
 * This gives Samuel the same "computer use" ability as Codex — it can interact with
 * ANY app on the desktop, not just a browser.
 */

import { invoke } from "./invoke-bridge";

type Environment = "mac" | "windows" | "ubuntu" | "browser";
type Button = "left" | "right" | "wheel" | "back" | "forward";

export interface Computer {
  environment?: Environment;
  dimensions?: [number, number];
  screenshot(): Promise<string>;
  click(x: number, y: number, button: Button): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, scrollX: number, scrollY: number): Promise<void>;
  type(text: string): Promise<void>;
  wait(): Promise<void>;
  move(x: number, y: number): Promise<void>;
  keypress(keys: string[]): Promise<void>;
  drag(path: [number, number][]): Promise<void>;
}

/**
 * Create a native macOS Computer that operates on the real desktop.
 * All actions happen at the OS level — clicks, typing, and screenshots
 * work on whatever app is currently visible/focused.
 */
export function createNativeComputer(): Computer {
  return {
    environment: "mac",
    dimensions: [1280, 900],

    async screenshot(): Promise<string> {
      const b64 = await invoke<string>("native_screenshot");
      return b64;
    },

    async click(x: number, y: number, button: Button = "left"): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "click",
        x,
        y,
        button,
      });
    },

    async doubleClick(x: number, y: number): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "double_click",
        x,
        y,
      });
    },

    async scroll(x: number, y: number, scrollX: number, scrollY: number): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "scroll",
        x,
        y,
        scrollX,
        scrollY,
      });
    },

    async type(text: string): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "type",
        text,
      });
    },

    async wait(): Promise<void> {
      await new Promise((r) => setTimeout(r, 2000));
    },

    async move(x: number, y: number): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "move",
        x,
        y,
      });
    },

    async keypress(keys: string[]): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "keypress",
        keys,
      });
    },

    async drag(path: [number, number][]): Promise<void> {
      await invoke<string>("native_computer_action", {
        action: "drag",
        path,
      });
    },
  };
}
