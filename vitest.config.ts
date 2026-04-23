import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    // Test environment
    environment: "node",

    // Include test patterns
    include: ["**/*.test.ts", "**/*.spec.ts"],

    // Exclude patterns
    exclude: ["node_modules", "dist", ".idea", ".git", ".cache"],

    // Global test timeout (10 seconds)
    testTimeout: 10000,

    // Setup files
    setupFiles: ["./vitest.setup.ts"],

    // Reporter options
    reporters: ["verbose"],

    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "**/*.d.ts",
        "**/*.config.ts",
        "**/vitest.setup.ts",
      ],
    },

    // Parallel execution
    threads: true,
    maxThreads: 4,
    minThreads: 1,
  },

  // Resolve path aliases
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@server": path.resolve(__dirname, "./server"),
      "@client": path.resolve(__dirname, "./client"),
    },
  },
});
