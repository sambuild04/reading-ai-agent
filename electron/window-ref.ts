import type { BrowserWindow } from "electron";

let ref: BrowserWindow | null = null;

export function setWindowRef(win: BrowserWindow | null): void {
	ref = win;
}

export function getWindowRef(): BrowserWindow | null {
	return ref;
}
