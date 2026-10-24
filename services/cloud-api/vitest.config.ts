import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Says once, in the run's output, whether the database tests run or skip.
    globalSetup: ["./test/support/announce-database.ts"],
    // The database tests share one local database (and one expiry sweep), so their files run one at a time.
    fileParallelism: !process.env.SUPABASE_TEST_URL,
  },
});
