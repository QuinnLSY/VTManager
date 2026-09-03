## 改动说明

<!-- 一句话说明这个 PR 做了什么 -->

## 改动动机

<!-- 解决什么问题？关联的 Issue：Fixes #xxx -->

## 实现要点

<!-- 关键改动点，便于 reviewer 理解 -->

- [ ]
- [ ]

## 验证结果

<!-- 请勾选已完成项，并说明具体验证步骤 -->

- [ ] Rust 单元测试通过（`cargo test --manifest-path src-tauri/Cargo.toml --lib`）
- [ ] 前端构建通过（`npm run build`）
- [ ] 相关 mock 回归脚本全绿（`VITE_MOCK=1 npm run dev` 后运行 `scripts/mock-verify-*.mjs`）
- [ ] 手工验证通过（请描述具体操作步骤与结果）

## 影响范围

<!-- 是否影响既有功能？是否涉及数据结构、设置项或命令变更？ -->

- [ ] 不涉及既有功能
- [ ] 涉及命令变更（已同步 `commands.rs` / `api.ts` / `mock/tauri.ts` 三处）
- [ ] 涉及设置项变更（已同步能力与默认回退）
- [ ] 涉及数据结构变更（已更新 `docs/UPGRADE.md` 与迁移逻辑）

## 其他

<!-- 截图、录屏或补充说明 -->
