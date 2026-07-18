import { defineConfig } from "vitest/config";

// Minimal standalone vitest config for smoke-testing plain async lib modules
// (documentsQueries.ts, configQueries.ts). Kept separate from vite.config.ts
// so the React/Tailwind plugins (unneeded for these node-environment unit
// tests) aren't pulled into the test run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
