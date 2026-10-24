import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
      // `server-only` throws outside a React Server build; in unit tests it is an empty module.
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./test/server-only.ts", import.meta.url)) },
    ],
  },
  test: { include: ["test/**/*.test.ts"] },
});
