// 仅在 VITE_MOCK=1 的浏览器联调环境下替代 Tauri 插件/事件 API（见 vite.config.ts alias）。
// 这里实现一个最小事件总线，让 listen/emit 在浏览器里真的可用 —— 否则
// 主窗口收不到 Rust 侧的 "pip-closed" 等事件，联调链路是断的。

type Handler = (e: any) => void;
const handlers: Record<string, Handler[]> = {};

// 独立全屏窗口是**另一个页面**，与主窗口之间靠 Rust 的 emit_to 通信。
// 浏览器联调里两个页面共享 localStorage，所以用 storage 事件模拟这条跨窗口链路。
const BROADCAST_PREFIX = "__vt_evt:";

function dispatchLocal(ev: string, payload: any) {
  (handlers[ev] || []).slice().forEach((h) => {
    try {
      h({ event: ev, payload });
    } catch {
      /* 单个监听异常不影响其他监听 */
    }
  });
}

function hookStorageOnce() {
  if ((window as any).__vtStorageHooked) return;
  (window as any).__vtStorageHooked = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key || !e.key.startsWith(BROADCAST_PREFIX) || e.newValue == null) return;
    const name = e.key.slice(BROADCAST_PREFIX.length);
    let payload: any = null;
    try {
      payload = JSON.parse(e.newValue).p;
    } catch {
      /* ignore */
    }
    dispatchLocal(name, payload);
  });
}

export async function listen(_ev: string, _h?: any): Promise<() => void> {
  const ev = String(_ev);
  if (typeof _h !== "function") return () => {};
  hookStorageOnce();
  (handlers[ev] ||= []).push(_h as Handler);
  return () => {
    handlers[ev] = (handlers[ev] || []).filter((x) => x !== _h);
  };
}

/** mock 后端主动广播事件（等价于 Rust 的 app.emit / emit_to） */
export function emitMock(ev: string, payload?: any) {
  dispatchLocal(ev, payload ?? null);
  try {
    // 带 nonce：相同值不会触发 storage 事件
    localStorage.setItem(
      BROADCAST_PREFIX + ev,
      JSON.stringify({ p: payload ?? null, n: `${Date.now()}-${Math.random()}` })
    );
  } catch {
    /* ignore */
  }
}

export function getCurrentWebview() {
  return {
    onDragDropEvent: async (_h?: any): Promise<() => void> => () => {},
  };
}

export async function open(_opts?: any): Promise<string | string[] | null> {
  return null;
}
export async function save(_opts?: any): Promise<string | null> {
  return null;
}
export async function message(_msg?: any, _opts?: any): Promise<void> {}
export async function ask(_msg?: any, _opts?: any): Promise<boolean> {
  return false;
}
export async function confirm(_msg?: any, _opts?: any): Promise<boolean> {
  return false;
}
