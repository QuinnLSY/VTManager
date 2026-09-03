#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VTManager 命令链路一致性审计（发版前自查用，无需 dev server / cargo 编译）。

对照 docs/UPGRADE.md 的「已实现功能禁止回退」约定，核查：
  1. #[tauri::command] 定义 ↔ main/commands.rs generate_handler 注册 ↔ src/api.ts invoke 调用，三方是否一致；
  2. mock(tauri.ts) 对前端会调用命令的分支覆盖（未覆盖 = 浏览器联调盲区，非错误但需知情）；
  3. 常见「重构易碎锚点」关键词在各组件的存在性粗查（详见下方 FRONT_ANCHORS，可按需增删）。

用法：python3 scripts/audit-command-consistency.py
退出码：0 = 无致命不一致；2 = 发现致命不一致（命令定义/注册/调用缺失）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fail = []


def extract_defined() -> set[str]:
    """提取所有 #[tauri::command] 标记后最近的 fn 名（可跨行）。"""
    out: set[str] = set()
    for f in (ROOT / "src-tauri/src").glob("*.rs"):
        src = f.read_text(encoding="utf-8")
        for m in re.finditer(r"#\[tauri::command\]", src):
            tail = src[m.end(): m.end() + 400]
            fn = re.search(r"(?:pub\s+)?fn\s+([a-z_][a-z0-9_]*)", tail)
            if fn:
                out.add(fn.group(1))
    return out


def extract_registered() -> set[str]:
    """提取 generate_handler![] 里的命令名。

    按逗号分段解析：跳过 // 注释行；每段（可为 `name,` 或 `crate::pip::name,`）
    取末尾标识符作为命令名（模块路径只取最后一段），避免注释文本/模块名混入。
    """
    src = (ROOT / "src-tauri/src/commands.rs").read_text(encoding="utf-8")
    m = re.search(r"generate_handler!\[(.*?)\n?\s*\]\s*\)", src, re.S)
    if not m:
        return set()
    names: set[str] = set()
    for seg in m.group(1).split(","):
        # 逐行删行内注释（// 到行尾），注释行可能与被注释的命令同段（注释行无逗号）
        lines = [re.sub(r"//.*$", "", ln) for ln in seg.splitlines()]
        cleaned = " ".join(lines).strip()
        if not cleaned:
            continue
        tail = re.search(r"([a-z_][a-z0-9_]*)\s*$", cleaned)
        if tail:
            names.add(tail.group(1))
    return names


def extract_api_calls() -> set[str]:
    """提取 api.ts 中所有 invoke 的首个字面量命令名（兼容嵌套泛型）。"""
    src = (ROOT / "src/api.ts").read_text(encoding="utf-8")
    return set(re.findall(r'invoke<[^>]*(?:>[^>]*)?>\s*\(\s*"([a-z_][a-z0-9_]*)"', src))


def extract_mock_cases() -> set[str]:
    src = (ROOT / "src/mock/tauri.ts").read_text(encoding="utf-8")
    return set(re.findall(r'case\s+"([a-z_][a-z0-9_]*)"', src))


def check(name: str, bad: set[str], hint: str) -> None:
    if bad:
        fail.append(f"[缺失] {name}: {sorted(bad)}")
        print(f"  ❌ {hint}（{len(bad)} 个）：")
        for b in sorted(bad):
            print(f"     - {b}")
    else:
        print(f"  ✅ {hint}")


# 前端组件「重构易碎锚点」粗查（关键词命中 >0 即认为存在；命中 0 需人工确认是否合理）
FRONT_ANCHORS: dict[str, list[str]] = {
    "src/components/VideoControls.vue": [
        "vc-rate-slider", "PRESET_RATES", "stepRate", "seekBy", "toggleMute",
        "vc-preview",  # 悬停帧预览
        "vc-sub-menu", "pickSubFile", "sub-size",  # 字幕菜单
        "emit('capture')", "onPipClick",
    ],
    "src/components/VideoPlayer.vue": [
        "vt_progress", "saveProgress", "loadProgress", "snapshotCurrentFrame",
        "probeSubtitlesFor", "stepRate", "mediaFullscreen",
    ],
    "src/components/PiPVideo.vue": [
        # PiP 视频字幕来自打开全屏时的快照（r7 约定：PiP 本地消费、不回写、不重新探测），
        # 因此无需 probeSubtitlesFor；锚点应为本地字幕渲染链路。
        "vt_progress", "saveProgress", "loadProgress", "stepRate",
        "subCues", "props.payload.subtitle", "cueAt",
    ],
    "src/components/ImageViewer.vue": [
        'e.key === "r"', "rotate", "onStripWheel", "closest", "600",
        "mediaFullscreen", "@dblclick.stop",
    ],
    "src/components/PiPImage.vue": [
        'e.key === "r"', "rotate", "onStripWheel", "closest", "600",
    ],
    "src/App.vue": [
        "fs-changed", "silentRefresh", "8000",  # 8 秒轮询兜底
        "scan-done", "onKey",
    ],
    "src/components/TrashView.vue": [
        "expire_at", "expireText", "trash_path", "getThumbs",
    ],
}


def main() -> None:
    defined = extract_defined()
    registered = extract_registered()
    called = extract_api_calls()
    mock = extract_mock_cases()

    print(f"命令统计：定义 {len(defined)} | 注册 {len(registered)} | api.ts 调用 {len(called)} | mock case {len(mock)}")

    print("\n== 1) 命令注册三方一致性 ==")
    check("定义但未注册（前端调用必失败）", defined - registered,
          "定义了但 generate_handler 未注册")
    check("注册但无 #[tauri::command] 定义", registered - defined,
          "注册了但找不到定义（可能误注册）")
    check("api.ts 调用但后端未注册（致命）", called - registered,
          "前端调用了但后端命令不存在")
    check("定义但 api.ts 从不调用（死命令）", defined - called,
          "后端有但前端无调用（人工确认是否该删/漏封装）")

    print("\n== 2) mock 联调覆盖盲区（非错误，仅知情） ==")
    blind = sorted(called - mock)
    if blind:
        print(f"  ⚠️ mock 无分支（调用将 throw「mock 未实现命令」，回归脚本应避开）：{blind}")
    else:
        print("  ✅ 前端全部调用在 mock 中都有分支")

    print("\n== 3) 前端重构易碎锚点粗查 ==")
    for rel, keys in FRONT_ANCHORS.items():
        p = ROOT / rel
        if not p.exists():
            print(f"  ⚠️ 文件不存在（可能已重构删除，请核对是否应保留）：{rel}")
            continue
        s = p.read_text(encoding="utf-8")
        miss = [k for k in keys if len(re.findall(re.escape(k), s, re.I)) == 0]
        if miss:
            print(f"  ⚠️ {rel} 缺失锚点：{miss}（命中 0 需人工确认是否被重构删除）")
        else:
            print(f"  ✅ {rel} 锚点齐全")

    print("\n" + ("=" * 40))
    if fail:
        print(f"发现 {len(fail)} 项致命不一致：")
        for x in fail:
            print(" ", x)
        sys.exit(2)
    print("命令链路一致性审计通过 ✅")


if __name__ == "__main__":
    main()
