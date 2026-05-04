import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/electron/**", "**/src-cli/**", "**/dist-electron/**"] },
  },
  build: {
    outDir: "dist-ui",
  },
});
