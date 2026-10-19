# PISCES AI v0.12.0 · UI 与交互改造

日期：2026-10-05。以下截图来自 v0.12.0 打包程序的隔离验收窗口，任务数据和文件为本机验收样例，不是生产用户数据。

## 本次解决的问题

原界面的主导航、二级标签和正文标题重复争夺注意力，部分正文与按钮偏小；首页的输入容易被任务列表挤出窗口，设置缺少一致的取消、未保存和焦点行为。本次保留用户选择的深绿色工作现场方向，统一这些操作和视觉层级。

| 原有问题 | 当前行为 |
| --- | --- |
| 各页重复的大标题和横向标签 | 四个主入口保留；工作、记忆与工具的子入口收进侧栏，正文显示当前页面内容 |
| 首页按列表铺满任务 | 先显示待核对事项，再显示进行中的工作；数量入口直接打开对应筛选 |
| 首页输入随着内容滑走 | 任务列表单独滚动，补充要求与输入区保留在可操作范围，验收覆盖 1024×820 |
| 字号、间距与控件各自为政 | 页面、任务和正文使用分级字号，统一森林色板、表面层级、按钮与焦点样式 |
| 设置是横向标签与长表单 | 左侧选择分区，右侧编辑，底部保留操作；即时生效的选项只显示关闭，连接配置提供保存 |
| 关闭设置可能直接丢弃修改 | 未保存的 AI 或核心连接修改可继续编辑或放弃；放弃不会写入配置 |
| 弹窗与快捷入口的焦点不统一 | 设置、命令面板及操作确认约束 Tab，支持 Escape，关闭后恢复入口焦点；模态窗口期间暂停背景交互 |
| MCP 入口重复、命令暴露在主标题 | 保留单一添加入口与连接/工具状态，启动命令和环境变量名称放进可展开的连接配置 |
| 页面标题笼统写“记忆” | 按理解、记住的事、技能、经验手册、档案与会话显示对应标题 |

## 打包程序截图

### 有任务的首页

需要核对的事情先出现；状态数量、实际进展和可纠正的用户认识各有清晰入口。首页只取两个优先事项，全部工作仍可进入。

![首页](./output/ui-experience-native/output/workspaces/home-overview.png)

### 第一次使用与小窗口

空状态提供可编辑的起点，不生成任务或理解记录。1024×820 下，首页任务内容可以滚动，输入仍可操作。

![首次使用](./output/ui-experience-packaged/output/playwright/ui-welcome.png)

![小窗口首页](./output/ui-experience-native/output/workspaces/home-narrow.png)

### 工作现场

按任务展示内容与结果，保留当前任务输入、草稿和执行依据。文档、数据、文件、研究、软件操作和持续跟进均沿用真实记录。

![数据工作区](./output/ui-experience-native/output/workspaces/data.png)

![文档与执行详情](./output/ui-experience-native/output/workspaces/document-inspector.png)

### 设置与未保存状态

不同分区使用同一布局；切换本机能力即时生效，AI 与核心连接配置需要保存。未保存修改的关闭过程可恢复。

![设置](./output/ui-experience-packaged/output/playwright/ui-settings.png)

![AI 服务设置](./output/ui-experience-packaged/output/playwright/ui-settings-providers.png)

![未保存修改](./output/ui-experience-packaged/output/playwright/ui-settings-unsaved.png)

### 用户理解与 MCP

认识与偏好仍可查看来源、纠正和删除；工具连接保留既有权限和执行方式。

![用户理解](./output/ui-experience-packaged/output/playwright/ui-memory.png)

![MCP](./output/ui-experience-packaged/output/playwright/ui-connectors.png)

## 已验证

| 验收 | 结果 | 记录 |
| --- | --- | --- |
| TypeScript、前端构建与 Windows 打包 | 通过，版本 0.12.0 | output/ui-experience-pack.log |
| 相关自动回归 | 108 / 108 通过 | output/ui-experience-regression.log |
| 打包版六种任务展示 | 通过：筛选、排序、展示切换、详情重试、断线恢复、草稿隔离、重启保留及小窗口输入 | output/ui-experience-workspaces-packaged.log |
| 打包版完整界面操作 | 通过：设置、未保存取消、焦点、快捷命令、MCP、后台确认及其他已有入口 | output/ui-experience-ui-packaged.log |
| 真实 Rust 核心与打包桌面连续性 | 通过：同一任务重启续做、跨会话修改、已确认偏好与实际文件核对 | output/ui-experience-continuity/continuity-result.json |

界面操作使用 20 次本地脚本模型请求，核心连续性使用 16 次本地脚本模型请求，无付费请求。核心测试启动独立临时运行目录，没有替换或停止生产核心。六种任务展示验收不调用模型。

108 项相关回归不包含此前有两项前台预检失败的 desktop-agent.test.cjs 套件，本次没有将该套件计为通过，也没有声称 npm test 全量通过。构建仍有已有的大体积前端资源提示，本轮未引入依赖。

## 交付与下一步验收

程序：`D:\PISCES AI\release\pisces-ai-v0.12.0\win-unpacked\PISCES AI.exe`。启动入口：`D:\PISCES AI\启动 PISCES AI.cmd`。源文件与构建同步到 `D:\记忆体桌面助手`，原启动入口继续转向当前项目。已有版本及改造前源文件备份保留。

这次完成可运行的界面和交互改造。成熟商业产品还需要长时间使用、不同缩放比例、屏幕阅读器、更多异常流程和真实用户任务的验收；当前本地自动检查不能代替这些验证。任务智能、长期理解和开放任务成功率也需要单独评测。
