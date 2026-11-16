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
  build: {
    rollupOptions: {
      output: {
        /**
         * 【拆包 M8】三方库按域分 chunk：
         *  - vendor-physics：@dimforge/rapier3d-compat（wasm base64 内联 ~1.3MB 文本），
         *    配合 physics-manager 的动态 import()，只有物理设施激活前才下载；
         *  - vendor-three / vendor-move / vendor-gui：与业务码隔离，
         *    业务改动不再打爆三方库的强缓存（/assets/* 一年 immutable）。
         * 注意顺序：three-mesh-bvh / three-player-controller 的路径都含 "three"，
         * 必须在 vendor-three 判定之前匹配。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@dimforge/rapier3d-compat')) return 'vendor-physics';
          if (id.includes('three-mesh-bvh') || id.includes('three-player-controller')) return 'vendor-move';
          if (id.includes('lil-gui')) return 'vendor-gui';
          if (id.includes('/node_modules/three/') || id.includes('\\node_modules\\three\\')) return 'vendor-three';
          return undefined;
        },
      },
    },
  },
  plugins: [
    {
      name: 'playground-cache-control',
      configureServer(server) { server.middlewares.use(cacheHeaders()); },
      configurePreviewServer(server) { server.middlewares.use(cacheHeaders()); },
    },
  ],
});