import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "url";
import fs from "node:fs";
import path from "node:path";

// VITE_MOCK=1 且仅在 dev server（npm run dev）时把 Tauri API 替换为 src/mock 下的
// 模拟实现，便于在 Chrome 中实测前端行为（如分栏拖拽）；build 永不启用，防止 mock 进生产包。
const mock = (cfg: { command: string }) =>
  cfg.command === "serve" && !!process.env.VITE_MOCK;
const m = (f: string) => fileURLToPath(new URL(`./src/mock/${f}`, import.meta.url));

/**
 * 联调专用：把 testlib 里的样例视频当成本地流服务返回（支持 Range），
 * 这样在浏览器里能真的播放/暂停/拖动进度，端到端验证播放器与全屏链路。
 * 仅在 VITE_MOCK 的 dev server 下挂载，生产构建完全不包含。
 */
function mockStreamPlugin(cfg: { command: string }) {
  if (!mock(cfg)) return null;
  const file = path.resolve(process.cwd(), "testlib/千与千寻.mp4");
  return {
    name: "vt-mock-stream",
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (!req.url || !req.url.startsWith("/__mockstream")) return next();
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end("missing sample video");
        }
        const total = fs.statSync(file).size;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        const range = req.headers.range as string | undefined;
        const mt = /bytes=(\d*)-(\d*)/.exec(range || "");
        if (mt) {
          const start = mt[1] ? parseInt(mt[1], 10) : 0;
          const end = mt[2] ? parseInt(mt[2], 10) : total - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
          res.setHeader("Content-Length", String(end - start + 1));
          fs.createReadStream(file, { start, end }).pipe(res);
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Length", String(total));
          fs.createReadStream(file).pipe(res);
        }
      });
    },
  } as any;
}

export default defineConfig((cfg) => ({
  plugins: [vue(), mockStreamPlugin(cfg)].filter(Boolean) as any[],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "safari15",
    minify: "esbuild",
    sourcemap: false,
    // 多入口：主窗口 + 独立画中画（PiP）窗口分别产出独立 HTML/JS/CSS，
    // PiP 窗口只打包它自己需要的代码（播放/查看器核心），避免冗余。
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        pip: fileURLToPath(new URL("./pip.html", import.meta.url)),
      },
    },
  },
  resolve: mock(cfg)
    ? {
        alias: [
          { find: "@tauri-apps/api/core", replacement: m("tauri.ts") },
          { find: "@tauri-apps/api/event", replacement: m("shims.ts") },
          { find: "@tauri-apps/api/webview", replacement: m("shims.ts") },
          { find: "@tauri-apps/api/window", replacement: m("shims.ts") },
          { find: "@tauri-apps/api/webviewWindow", replacement: m("shims.ts") },
          { find: "@tauri-apps/plugin-dialog", replacement: m("shims.ts") },
        ],
      }
    : undefined,
}));