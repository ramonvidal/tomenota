import { defineConfig } from 'vite';

// Política de segurança (CSP) embutida no HTML do build.
// Necessária no GitHub Pages, que não permite headers próprios (no Cloudflare o public/_headers também vale).
// Só no build: o servidor de desenvolvimento do Vite usa scripts inline que a CSP bloquearia.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const cspMeta = {
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
  ],
};

export default defineConfig({
  // BASE_PATH=/tomenota/ no GitHub Pages (site em subpasta); "/" no Cloudflare.
  base: process.env.BASE_PATH || '/',
  build: { target: 'es2022' },
  plugins: [cspMeta],
});
