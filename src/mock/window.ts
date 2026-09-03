// 仅在 VITE_MOCK=1 的浏览器联调环境下替代 @tauri-apps/api/window（见 vite.config.ts alias）。
// 模拟窗口全屏状态，让播放器/查看器的全屏按钮在浏览器中可实测。

let fullscreen = false;

export function getCurrentWindow() {
  return {
    isFullscreen: async () => fullscreen,
    setFullscreen: async (v: boolean) => {
      fullscreen = v;
      document.documentElement.dataset.mockFullscreen = v ? "1" : "0";
    },
    onResized: async (_h?: any): Promise<() => void> => () => {},
  };
}
