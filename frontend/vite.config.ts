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
    // In Docker (NODE_ENV=production) output to /app/frontend-static/ so it
    // survives the Nosana volume mount that overwrites /app/dist/ at runtime.
    // Locally (NODE_ENV unset or development) keep the normal ../dist/frontend path.
    outDir: process.env.NODE_ENV === "production"
      ? "/app/frontend-static"
      : "../dist/frontend",
    emptyOutDir: true,
  },
});
