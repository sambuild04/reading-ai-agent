declare global {
  interface Window {
    __electronWindow: {
      setSize: (width: number, height: number) => void;
    };
  }
}

export class LogicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

class ElectronWindow {
  setSize(size: LogicalSize) {
    window.__electronWindow?.setSize(size.width, size.height);
  }
}

const singleton = new ElectronWindow();

export function getCurrentWindow() {
  return singleton;
}
