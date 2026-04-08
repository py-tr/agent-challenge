import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/pulse/tests/**/*.test.ts"],
    // Run tests sequentially — PGLite in-memory instances can conflict.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
