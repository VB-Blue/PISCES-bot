# PISCES AI

<p align="center">
  <strong>AI 正常工作，核心从真实经验中成长的桌面工作台</strong><br>
  <em>A desktop workbench where AI does real work and the core grows from real experience.</em>
</p>

<p align="center">
  <a href="#-中文">🇨🇳 中文</a> &nbsp;|&nbsp; <a href="#-english">🇬🇧 English</a>
</p>

---

## 🇨🇳 中文

### 📖 项目概述

**PISCES AI** 是一款面向专业工作场景的桌面智能工作台。与常规的套壳聊天客户端不同，PISCES AI 拥有独立的后台常驻进程、自主领域认知机制、持久化记忆体核心，以及深度的桌面控制与外部浏览器自动化执行能力。

它不仅能与用户自然对话，更能承担复杂、长周期的真实业务任务：自主拆解步骤、委派子代理协同、调度合适的 AI 服务、产出可直接交付的机械证据产物，并在持续实践中不断积累经验与进化认知。

---

### ✨ 核心特性

#### 1. 🧠 记忆体深度连接 (Memory Core Link)
- **核心数据持久化**：长期记忆、技能库、行为偏好、用户画像、对话上下文与长期要求均由专用记忆体核心统一托管。
- **离线排队与自动重连同步**：核心离线时，本地任务与状态自动排队暂存；连接恢复后平滑回传，首次连接支持历史数据全量平滑迁移。

#### 2. 🧭 领域认知与自主学习 (Domain Cognition)
- **陌生领域自动研判**：理解任务后，核心主动研判自身在该专业领域的知识掌握程度。
- **结构化自驱学习**：对缺乏经验的领域自动制定调研方案、收集样本、归纳底层规则；在后续执行中对照检验、推翻或确认规律，学习效果计入成长评分。

#### 3. ⚡ 多 AI 服务智能路由与容灾 (AI Service Routing)
- **多模型供应商统一调度**：支持 OpenAI、Claude、DeepSeek、火山方舟、硅基流动、MiniMax 等主流服务商。
- **智能场景匹配**：根据服务模型特征自动识别擅长领域；遇到连续报错、密钥失效或额度不足时自动熔断避让；当默认服务并发达到上限时无感分流，保障任务高可用。
- **手动偏好锁定**：支持用户针对具体对话、任务或长期目标手动锁定特定 AI 服务。

#### 4. 🎨 多模态与多媒体生成 (Media Generation)
- **文生图与文生视频**：原生接入 OpenAI 图片接口与主流视频生成服务（OpenAI 视频、火山方舟、硅基流动、MiniMax），支持自动轮询任务进度与本地归档。
- **对话内即时预览与播放**：生成的图像直接在对话中渲染，视频支持就地流式播放与进度拖动，安全限制于授权目录。

#### 5. 🖥️ 桌面控制与浏览器执行 (Desktop & Browser Automation)
- **桌面视力与操作**：利用编号视觉标记、OCR 文字识别及精准窗口聚焦驱动本地软件。
- **外部浏览器自动化**：支持深度接管 Chrome / Edge，执行元素定位、富文本输入、拖拽、上传下载及登录态持久会话。
- **高危操作人机协同 (Human-in-the-Loop)**：涉及文件删除、敏感变更或破坏性操作前强制提示人工授权确认。

#### 6. 📋 任务工作区与长期目标治理 (Task Workspaces & Long-term Goals)
- **多状态工作区**：“此刻”看板与“一起在做”任务面板清晰呈现当前执行状态。
- **多代理协作与委派**：支持多角色分工（规划者、执行者、核对者、研究员），支持串行与并行协同编排。
- **长期目标与证据验收**：长期目标支持定期自动调度，坚持以机械文件事实作为交付标准，严禁无证据凭模型自述“验收通过”。

---

### 🛠️ 快速上手

#### 环境要求
- **操作系统**：Windows 10 / 11（推荐）或 macOS / Linux（部分桌面自动化能力适配中）
- **Node.js**：>= 18.0.0
- **包管理器**：npm

#### 安装与启动

1. **克隆代码仓库**
   ```bash
   git clone https://github.com/VB-Blue/PISCES-bot.git
   cd PISCES-bot
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **开发模式运行**
   ```bash
   # 启动 Vite 前端服务
   npm run dev

   # 启动桌面端 (构建前端并拉起 Electron)
   npm run desktop
   ```

4. **双击启动脚本 (Windows)**
   - 也可直接双击根目录下的 `启动 PISCES AI.cmd` 启动已部署的本地应用。

#### 构建与打包
```bash
# 检查 TypeScript 类型并构建前端资源
npm run build

# 打包便携桌面端安装目录 (Windows x64)
npm run pack
```

#### 运行测试
```bash
# 运行全部自动化测试套件
npm test
```

---

### 📂 目录结构

```text
├── electron/               # Electron 主进程、后台常驻服务与桌面执行器
│   ├── main.cjs            # Electron 主入口与生命周期管理
│   ├── assistant-worker.cjs# 核心工作线程与任务执行调度
│   ├── desktop-agent.cjs   # 桌面控制、视力识别与操作引擎
│   ├── brain.cjs           # 系统 Prompt、工具组装与多代理分发
│   ├── service-routing.cjs # 多 AI 服务健康探测与智能路由
│   └── ...
├── src/                    # 现代化 React 19 前端界面
│   ├── App.tsx             # 应用主工作台入口
│   ├── Presence.tsx        # “此刻”与“一起在做”状态在场看板
│   ├── TaskWorkspace.tsx   # 任务多形态工作区
│   ├── NewWorkForm.tsx     # 新建任务与快速调度表单
│   └── ...
├── scripts/                # 冒烟验证、图标生成与打包脚本
├── tests/                  # 自动化单测与回归测试套件
├── package.json            # 项目依赖与运行脚本
├── LICENSE                 # 开源许可与版权保护协议全文
└── README.md               # 项目主说明文档
```

---

### ⚙️ 配置说明

首次启动后，在主界面左下角打开 **设置**：
- **AI 服务**：添加您的模型服务地址、API Key 与模型名称，可为不同服务指定“擅长”标签（如编码、文本、图像、视频）。
- **核心连接**：配置本地记忆体核心通信地址（默认 `http://127.0.0.1:18789`）。
- **本机能力**：管理桌面控制、浏览器自动化、剪贴板与本地文件访问权限。

---

### 📄 开源许可与版权保护声明

本项目采用 **PISCES AI 源码可用非商业及防抄袭许可协议 (PISCES AI Source-Available Non-Commercial & Anti-Plagiarism License)**。版权所有 © 2026 VB-Blue / PISCES AI。保留所有权利。

- 🚫 **严禁任何商业化用途 (Strictly Non-Commercial)**：
  - 本项目源代码、设计与衍生程序**仅供个人非商业学习、学术研究及技术评估使用**。
  - 严禁任何形式的直接或间接商业盈利行为，包括但不限于：软件销售、商业分发、部署为收费 SaaS / API 云服务、嵌入企业盈利性生产系统或商业产品中。
- 🛡️ **严禁抄袭剽窃与“换皮”搬运 (Anti-Plagiarism & Brand Protection)**：
  - **禁止抄袭与换皮**：严禁直接复制本项目的核心架构、系统设计或源代码，并伪装、篡改作者署名、重命名（换皮）后公开发布或宣称为个人/第三方的原创成果。
  - **禁止闭源包装**：严禁抽取本项目核心代码整合进其他闭源或商业竞争产品中二次分发。
  - **必须完整保留署名**：在允许的学术研究或非商业引用范围内，必须显著保留原作者版权声明、许可证全文以及项目开源地址。
- ⚖️ **法律追责保留**：
  - 任何未经授权的商业化使用、抄袭剽窃或侵权分发行为将导致许可自动终止。著作权人保留依据《中华人民共和国著作权法》、《中华人民共和国反不正当竞争法》以及国际版权公约（如 DMCA、伯尔尼公约）追究侵权者全部法律责任的权利（包括申请平台侵权封禁下架、追索侵权所得及法定损害赔偿）。

完整法律条款请参阅根目录下的 [LICENSE](LICENSE) 文件。

---

<br>

## 🇬🇧 English

### 📖 Overview

**PISCES AI** is a professional-grade intelligent desktop workbench. Unlike conventional chat wrappers, PISCES AI is backed by an independent persistent background daemon, autonomous domain cognition, a linked long-term memory core, and deep operating system control covering desktop GUI and external browser automation.

PISCES AI is designed to carry out complex, multi-stage real-world workloads: decomposing goals, delegating tasks among specialized agents, balancing requests across multiple AI services, delivering mechanically verifiable evidence, and continuously evolving its cognition through practice.

---

### ✨ Key Features

#### 1. 🧠 Memory Core & Long-Term Intelligence
- **Persistent Core State**: Profile attributes, learned skills, preferences, historical context, and persistent cross-session rules are maintained by a dedicated memory core.
- **Offline Queue & Seamless Resumption**: Offline changes queue safely on the local node and sync back immediately upon reconnection.

#### 2. 🧭 Domain Cognition & Autonomous Learning
- **Unfamiliar Domain Assessment**: The memory core actively evaluates its own domain knowledge depth before executing novel tasks.
- **Hypothesis-Driven Growth**: Formulates structured research plans, samples data, induces underlying principles, and validates them via controlled trials.

#### 3. ⚡ Multi-Provider AI Routing & Resilience
- **Unified Multi-Service Management**: Seamlessly coordinates OpenAI, Claude, DeepSeek, SiliconFlow, Volcano Ark, MiniMax, and custom endpoints.
- **Dynamic Spillover & Circuit Breaking**: Matches models to tasks based on inherent strengths, automatically avoids exhausted keys or flaky endpoints, and redirects traffic during high concurrency.
- **Manual Pinning**: Users can lock specific AI services for critical conversations, tasks, or long-term workflows.

#### 4. 🎨 Multimodal Media Generation
- **Text-to-Image & Text-to-Video**: Integrates standard image endpoints (`/images/generations`) and multi-format video generation with asynchronous polling and automatic local storage.
- **In-Chat Rendering & Streaming**: Directly renders generated images in the message stream; video playback supports seeking and scrubbing within authorized folders.

#### 5. 🖥️ Desktop Control & Browser Automation
- **Visual Desktop Execution**: Numbered overlay tags, OCR fallback, and target window management to drive native desktop applications.
- **Browser Automation**: Full external Chrome / Edge integration for precise DOM navigation, rich text input, drag-and-drop, and authenticated sessions.
- **Human-in-the-Loop Safety**: Irreversible or sensitive file/system actions require explicit user confirmation.

#### 6. 📋 Task Workspaces & Evidence Verification
- **Dual Work Presence**: Real-time "Present" and "Working Together" dashboards for full task visibility.
- **Multi-Agent Delegation**: Orchestrates multiple roles (Planner, Executor, Reviewer, Researcher) with serial and parallel pipelines.
- **Verifiable Deliverables**: Insists on hard file evidence for goal completion rather than accepting unsubstantiated model self-claims.

---

### 🛠️ Quick Start

#### Prerequisites
- **Operating System**: Windows 10 / 11 (recommended) or macOS / Linux
- **Node.js**: >= 18.0.0
- **Package Manager**: npm

#### Installation & Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/VB-Blue/PISCES-bot.git
   cd PISCES-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   ```bash
   # Launch Vite frontend
   npm run dev

   # Launch desktop application (builds frontend & starts Electron)
   npm run desktop
   ```

4. **Launch via Windows script**
   - You can also double-click `启动 PISCES AI.cmd` in the project root.

#### Build & Package
```bash
# Type check and compile frontend
npm run build

# Pack portable desktop binaries (Windows x64)
npm run pack
```

#### Run Tests
```bash
# Execute test suite
npm test
```

---

### 📂 Repository Structure

```text
├── electron/               # Electron main process, assistant worker & automation engines
│   ├── main.cjs            # Electron entry & lifecycle orchestration
│   ├── assistant-worker.cjs# Main worker thread & execution pipeline
│   ├── desktop-agent.cjs   # Desktop automation, OCR & vision targeting
│   ├── brain.cjs           # System prompts, tools assembly & agent roles
│   ├── service-routing.cjs # Health checks & smart routing across AI providers
│   └── ...
├── src/                    # React 19 frontend workbench
│   ├── App.tsx             # Root application component
│   ├── Presence.tsx        # Presence & active work views
│   ├── TaskWorkspace.tsx   # Multi-modal task workspaces
│   ├── NewWorkForm.tsx     # Task dispatch & configuration modal
│   └── ...
├── scripts/                # Smoke tests, icon generation & packaging utilities
├── tests/                  # Unit and integration test suites
├── package.json            # Package configuration and dependencies
├── LICENSE                 # Full license text
└── README.md               # Main bilingual documentation
```

---

### ⚙️ Configuration

Open **Settings** (gear icon in the lower-left corner) after first launch:
- **AI Services**: Configure provider base URLs, API keys, and model names; tag model specializations (Code, Text, Image, Video).
- **Core Connection**: Set memory core endpoint (default: `http://127.0.0.1:18789`).
- **Native Abilities**: Grant or review permissions for desktop control, browser automation, clipboard, and file access.

---

### 📄 License & Intellectual Property Protection

This project is distributed under the **PISCES AI Source-Available Non-Commercial & Anti-Plagiarism License**.
Copyright © 2026 VB-Blue / PISCES AI. All Rights Reserved.

- 🚫 **Strictly Non-Commercial Use**:
  - The source code, system designs, and compiled binaries are provided **solely for personal study, academic research, and evaluation**.
  - Any commercial use, monetization, paid SaaS/API hosting, software resale, or deployment within revenue-generating business operations is **strictly prohibited** without explicit written permission from the copyright holder.
- 🛡️ **Anti-Plagiarism & Brand Protection**:
  - **No Rebranding or "Skinning"**: You may NOT copy the codebase, architecture, or user experience and redistribute it under another name, disguised authorship, or as a proprietary competing product.
  - **No Closed-Source Derivatives**: Extracting core components to bundle into closed-source or commercial offerings is prohibited.
  - **Mandatory Attribution**: All permitted non-commercial references or academic citations must conspicuously retain the original copyright notice, full license text, and repository link.
- ⚖️ **Legal Enforcement**:
  - Any breach automatically terminates all permissions. The author reserves all rights to seek statutory damages, injunctive relief, DMCA takedowns, and full legal remedies under applicable domestic and international copyright laws.

For complete terms and conditions, please refer to the [LICENSE](LICENSE) file.
