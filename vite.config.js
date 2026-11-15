import { defineConfig } from 'vite';

/**
 * 手册 P6 网络优化：缓存策略。
 * 构建产物 /assets/* 带内容哈希 → 一年 immutable；入口 html 永远 no-cache，
 * 保证发版后用户立即拿到新哈希引用。dev 与 preview 两套中间件同一规则。
 * CDN 部署属运维侧（见《部署与更新说明》），本地仅落实响应头。
 */
const cacheHeaders = () => (req, res, next) => {
  const path = (req.url || '').split('?')[0];
  if (path.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path === '/' || path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
};

export default defineConfig({
  plugins: [
    {
      name: 'playground-cache-control',
      configureServer(server) { server.middlewares.use(cacheHeaders()); },
      configurePreviewServer(server) { server.middlewares.use(cacheHeaders()); },
    },
  ],
});