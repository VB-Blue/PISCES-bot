# 多对话与多 API 验收

日期：2026-10-08。版本：0.14.0。

修复了两层全局串行限制：React 界面的全局 busy/单个请求引用，以及 Electron 主进程的 requests.size 拒绝逻辑。现在请求按对话登记，同一对话防止重复发送，不同对话可以并行。流、计划、工具回执、迟到的学习结果和完成回调按请求标识回到原对话。工作区的停止按钮按所选任务对应的对话取消；请求结束不会释放另一项任务的屏幕控制权。

对话文字草稿和手动指定的服务保存在 workspace.json；附件和软件目标按对话保存在运行内存中。加载和保存不再只保留前 40 段对话。仍使用原 MemoryDesktopAssistant 数据目录以及主进程的加密密钥。

## 服务分配

原有 providers.json 支持的多个服务已接入日常对话及后台任务。请求先按文字、对话接续上下文和图片需求选择服务；主体接受结构化理解后，再按实际任务类别调整执行服务。角色指定和对话手动指定优先，未匹配时使用默认服务。规划、审阅和记忆整理使用各自的角色设置。支持最多 20 个服务配置。

网络传输层对同一个服务配置统一限制并发数，覆盖普通执行、认知调用、学习和子代理。等待额度的请求支持取消，错误或取消后释放额度。备用服务采用自己的密钥和并发额度。手动授权的软件窗口任务仍绑定授权弹窗显示的服务。

屏幕操作串行执行，读取资料、对话、文件任务和其他 API 请求可以继续。自动分配使用配置标签和任务理解；本次没有调用付费模型进行能力评分。

## 已验证

- 全部 126 项自动测试通过，覆盖已有功能以及新增的独立对话登记、单段取消、API 排队取消、跨 API 并行、普通执行/认知/记忆整理共享额度、规划独立密钥与失败切换、结构化理解后调整服务、屏幕锁的取消与归属。结果在 `output/multi-conversation-unit.log`。
- 真实 Electron 界面的 13 项并发检查通过，覆盖运行中查看其他对话、新建并执行第二项任务、草稿与服务选择隔离、工作区停止所选任务、非当前对话完成后保存、同 API 排队、另一 API 后台任务继续、排队取消不发请求、手动选择优先、回复服务记录、两个审批均可处理，以及重载恢复草稿。使用四个本地脚本化模型，付费调用 0 次。报告在 `output/multi-conversation-smoke.json`。
- 真实 Rust 核心与桌面 IPC 的持续任务检查通过：跨对话更正、核心重启后继续同一件事、已确认偏好恢复、实际文件核对、详情和回执推送、工作区接续以及不覆盖后来编辑的草稿。使用 release 核心的隔离状态目录，不修改生产记忆。报告在 `output/multi-conversation-continuity`。

截图：`output/playwright/multi-conversation-work.png`、`output/playwright/multi-conversation-approval.png`、`output/playwright/multi-conversation-history.png`。

最终 Windows 打包程序重复通过 13 项并发检查，报告在 `output/multi-conversation-packaged/output/multi-conversation-smoke.json`。上述截图来自最终打包程序。原有综合界面冒烟检查和六种工作区、多语言、离线重开检查也通过，日志分别为 `output/multi-conversation-regression-ui.log` 和 `output/multi-conversation-regression-workspaces.log`。构建和打包成功，核对了包内 12 个主要运行文件与源码一致。

程序位于 `release/pisces-ai-v0.14.0/win-unpacked/PISCES AI.exe`，原启动脚本优先使用此版本。测试和打包采用隔离进程；正在运行的旧版本需要从托盘彻底退出，再双击原启动脚本。
