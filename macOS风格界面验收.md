# PISCES AI v0.15.0 视觉更新

2026-10-08。按 macOS 原生工作台的方向更新布局、字体、颜色与材质，保持现有指纹标志和四个主入口。

## 已交付

- 灰白浅色与石墨灰深色，系统蓝用于主要操作和选择反馈。状态保留独立的红色、琥珀色。
- 原生系统字体优先；本机实测英文使用 Segoe UI Variable，中文使用 Microsoft YaHei UI。标题 27–30px，正文 14–15px，细分标题、正文和辅助文字的字重。
- 统一 232px 侧栏、62px 工具栏、页面留白和工作分栏；小窗口使用更窄侧栏，保持任务输入区可见。
- 半透明界面背景、内侧高光、浅阴影与低对比度边框。7px 控件、10px 导航、14px 内容面板、18px 对话框。
- 首页、工作现场、对话、记录、设置、API 服务表单、连接器、记忆与任务页面使用同一套表面与控件。
- 新安装默认浅色，已有用户的浅色或深色选择保留。减弱动态与减弱透明度模式有对应 CSS 回退。
- 原启动脚本和已发现的开始菜单入口均指向 v0.15.0。

共享颜色与材质现在仅在 `src/tokens.css` 定义；原有多个文件的重复调色定义已移除。未增加组件或动画依赖。

## 实际截图

以下图片来自最终 Windows 安装包的真实 Electron 窗口。

- [浅色首页](./output/macos-home-light.png)
- [浅色工作与详情](./output/macos-work-light.png)
- [深色数据工作区](./output/macos-work-dark.png)
- [浅色设置](./output/macos-packaged-ui/output/playwright/ui-settings-providers-light.png)
- [1024px 小窗口](./output/macos-packaged-workspaces/output/workspaces/home-narrow-light.png)

工作截图使用隔离验收资料；首页截图为空状态。未生成产品中的虚构用户记录。

## 验证结果

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| 类型检查、生产构建、Windows 打包 | 通过 | `output/macos-package.log` |
| 既有单元测试 | 126 / 126 通过 | `output/macos-unit.log` |
| 最终安装包界面全流程 | 通过 | `output/macos-packaged-ui.log` |
| 文档、数据、文件、研究、桌面、跟进六类工作场景 | 通过 | `output/macos-packaged-workspaces.log` |
| 简体中文、English、繁體中文与重启恢复 | 通过 | 同上 |
| 小窗口、独立滚动、持续可见的输入区、草稿隔离 | 通过 | 同上及 `*-surface.json` |
| 键盘导航、对话框焦点、保存、取消与未保存提示 | 通过 | 界面与工作场景记录 |
| 多对话与按任务能力分配 API | 13 项通过 | `output/macos-packaged-concurrency.log` |
| 核心文字、按钮、状态的 12 组颜色对比 | 最低 4.75:1 | `output/macos-contrast.json` |
| 字体实际使用情况 | 系统字体已验证 | `output/macos-packaged-workspaces/output/workspaces/typography.json` |
| 安装包与最终构建、运行时代码一致 | 12 个运行时文件、2 个编译资源逐字节一致 | `output/macos-package-verified.json` |
| 开始菜单入口 | 已验证指向新版 | `output/macos-launcher-verified.json` |

UI 与并发验收使用本机脚本模型服务器，六类工作场景使用本机只读验收核心；未请求收费模型，也未改动生产 API 配置或用户工作记录。日志中不可达核心、失效服务与不支持语言的错误属于恢复能力验收输入。

## 打开新版

使用原来的 `启动 PISCES AI.cmd` 或开始菜单中的 PISCES AI。若旧版本仍在托盘运行，先选择“彻底退出”，再打开新版。右上角的太阳或月亮按钮切换主题。

程序路径：`D:\PISCES AI\release\pisces-ai-v0.15.0\win-unpacked\PISCES AI.exe`。

源文件与旧开始菜单快捷方式已备份到 `C:\Users\Willam\AppData\Local\PISCES AI\backups\macos-surface-20261008`。
