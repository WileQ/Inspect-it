import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Inject a strict Content-Security-Policy meta tag into the PRODUCTION build
// only (the dev server needs inline scripts/HMR and is intentionally exempt).
//
// Documented exceptions:
//  - style-src 'unsafe-inline': React sets inline style attributes (progress
//    bars, visualizations). This scopes inline styles to style attributes;
//    there is no inline <script> and script-src stays 'self'.
//  - connect-src http: https:: the optional AI provider and the website
//    analyzer fetch user-configured http(s) endpoints.
function productionCsp() {
  return {
    name: 'inject-production-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) {
          return html; // development: keep HMR working
        }
        const csp = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' http: https:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'"
        ].join('; ');
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
        );
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_NAME__: JSON.stringify(pkg.productName || pkg.name || 'Inspect This'),
    __APP_REPOSITORY_URL__: JSON.stringify(pkg.repository?.url || pkg.homepage || '')
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs']
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // tesseract.js is bundled for the browser OCR path (lazy dynamic import)
      // and resolved from node_modules in Node/tests and the Electron main
      // process. OCR degrades gracefully if the engine is ever absent.
      external: []
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
