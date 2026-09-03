import { createApp } from "vue";
import PiPRoot from "./components/PiPRoot.vue";
import "./pip-styles.css";

// 独立窗口入口：仅打包播放/查看器所需组件；不依赖主窗口的 store/App。
// 启动数据通过 URL query `?label=...` 传入，PiPRoot 在 onMounted 中调用
// getPipPayload(label) 拉取媒体列表与启动参数。
createApp(PiPRoot).mount("#pip");