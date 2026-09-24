import { defineConfig } from "vitest/config";

// Standalone vitest config (node environment, no React/Tailwind plugins) for the
// i18n catalog audit and runtime tests. Kept apart from vite.config.ts on purpose.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
