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
    // Vite always sets NODE_ENV=production before evaluating this config, so we
    // cannot use NODE_ENV to distinguish Docker from local.  Instead the Dockerfile
    // sets PULSE_DOCKER_BUILD=1 explicitly so we can branch on that without
    // conflicting with anything Vite controls.
    //
    // Docker (PULSE_DOCKER_BUILD=1):  /srv/pulse-frontend — outside /app entirely
    //   so the Nosana volume mount that covers /app cannot wipe the built assets.
    // Local (unset):                  ../dist/frontend — standard Vite output path.
    outDir: process.env.PULSE_DOCKER_BUILD
      ? "/srv/pulse-frontend"
      : "../dist/frontend",
    emptyOutDir: true,
  },
});
