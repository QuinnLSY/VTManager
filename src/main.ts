import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

// 全局错误兜底：仅开发模式显示错误面板，生产版静默（避免遮挡界面）
if (import.meta.env.DEV) {
  window.addEventListener("error", (e) => {
    showFatal(`${e.message}\n${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    showFatal(`Promise: ${e.reason}`);
  });

  const origErr = console.error.bind(console);
  console.error = (...args: any[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : String(a?.stack || a)))
      .join(" ");
    if (!text.includes("Vue warn")) {
      showFatal(text);
    }
    origErr(...args);
  };
}

function showFatal(msg: string) {
  let el = document.getElementById("fatal-error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "fatal-error";
    el.style.cssText =
      "position:fixed;inset:auto 12px 12px 12px;max-height:40vh;overflow:auto;z-index:99999;background:#2b1b1e;color:#ffb4be;padding:12px;border-radius:10px;font-size:12px;white-space:pre-wrap;";
    document.body.appendChild(el);
  }
  el.textContent += msg + "\n";
}

createApp(App).mount("#app");
