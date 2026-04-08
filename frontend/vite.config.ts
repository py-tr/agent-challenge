import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // In production the frontend is served at /pulse/dashboard/ by the ElizaOS backend.
  // base must match that mount point so Vite emits absolute asset URLs.
  base: "/pulse/dashboard/",
  server: {
    port: 5173,
    proxy: {
      "/pulse": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
});
