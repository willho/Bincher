import { beforeAll, afterAll, vi } from "vitest";

/**
 * Global test setup for Penny-Pincher2 test suite
 * Handles initialization and teardown of test environment
 */

// Set test environment variables
process.env.NODE_ENV = "test";

// Mock external services that shouldn't be hit in tests
beforeAll(() => {
  // Mock environment variables for testing
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/penny_pincher_test";
  }

  // Add other environment setup as needed
  console.log("[Test Setup] Test environment initialized");
});

afterAll(() => {
  console.log("[Test Setup] Test environment cleaned up");
});

/**
 * Mock fetch for API tests (if needed in future)
 * Currently commented out - uncomment if tests make external API calls
 */
/*
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  })
);
*/

/**
 * Mock console methods to reduce noise during testing
 * Keep only errors and important info
 */
const originalError = console.error;
const originalWarn = console.warn;

// Filter out certain console messages during tests
console.error = (...args: any[]) => {
  const message = args[0]?.toString() || "";

  // Skip certain error messages that are expected in tests
  if (
    message.includes("Mock implementation required") ||
    message.includes("Expected an implementation")
  ) {
    return;
  }

  originalError(...args);
};

console.warn = (...args: any[]) => {
  const message = args[0]?.toString() || "";

  // Skip certain warnings that are expected in tests
  if (message.includes("deprecated") && message.includes("test")) {
    return;
  }

  originalWarn(...args);
};

// Restore after tests
afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
});
