/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    globals: false
  },
  server: {
    host: true,
    port: 8080
  },
  preview: {
    host: true,
    port: 8080
  }
});
