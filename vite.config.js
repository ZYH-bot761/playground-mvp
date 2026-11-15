import fs from 'node:fs';
import { defineConfig } from 'vite';

/**
 * 运行配置统一放 config/default.json（工程化目录整理后单一真相源）。
 * 手册 P6 网络优化：构建产物 /assets/* 带内容哈希 → 一年 immutable；
 * 入口 html 永远 no-cache，保证发版后用户立即拿到新哈希引用。
 * dev 与 preview 两套中间件同一规则。CDN 部署属运维侧（见 docs/）。
 */
const appConfig = JSON.parse(
  fs.readFileSync(new URL('./config/default.json', import.meta.url), 'utf8')
);

const cacheHeaders = () => (req, res, next) => {
  const path = (req.url || '').split('?')[0];
  if (path.startsWith('/assets/')) {
    res.setHeader('Cache-Control',
      `public, max-age=${appConfig.cache.hashedAssetMaxAge}, immutable`);
  } else if (path === '/' || path.endsWith('.html')) {
    res.setHeader('Cache-Control', appConfig.cache.htmlCacheControl);
  }
  next();
};

export default defineConfig({
  server: {
    host: appConfig.dev.host,
    port: appConfig.dev.port,
    strictPort: appConfig.dev.strictPort,
  },
  plugins: [
    {
      name: 'playground-cache-control',
      configureServer(server) { server.middlewares.use(cacheHeaders()); },
      configurePreviewServer(server) { server.middlewares.use(cacheHeaders()); },
    },
  ],
});