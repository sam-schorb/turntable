import { defineConfig } from "vite";

const releaseHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

export default defineConfig({
  server: {
    headers: releaseHeaders
  },
  preview: {
    headers: releaseHeaders
  }
});
