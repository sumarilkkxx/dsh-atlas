# DSH Atlas

> 把 DeepSeek Harness 的线性对话历史转换为可拖拽、可分支、可继续工作的可视化会话画布。

DSH Atlas 是面向 DeepSeek Harness Web 的对话管理插件。它以 DSH 原始 Session Log 为事实来源，将每次提问、回答、工具调用和真实分支投影为卡片与连线，让长会话不再只能从上到下滚动查找，同时保留原生模型选择、命令执行和继续对话能力。

## 为什么需要 Atlas

随着对话轮次增加，关键结论、替代方案、工具结果和分支上下文很容易淹没在线性消息流中。Atlas 提供另一种组织方式：

- 一个主会话对应一张独立画布。
- 一轮“用户问题 + DSH 回答”对应一张卡片。
- 原生会话分支对应画布中的真实分支节点。
- Atlas 负责整理和导航，DSH 仍负责模型、命令、工具与会话历史。

## 核心功能

### 会话画布

- 按 DSH 工作区整理会话，进入卡片视图时自动定位当前原生会话。
- 每个主会话使用独立画布，避免把所有历史对话平铺到同一空间。
- 支持整卡拖拽、画布平移、50%–400% 缩放、自动整理和当前节点定位。
- 使用平滑曲线连接上下文节点，并通过二级菜单快速定位真实会话分支。
- 卡片位置持久化到本地 Atlas 数据库；缩放、视口和折叠状态保存在浏览器本地。
- 每次打开或切换画布时，Atlas 会先展示已有摘要；当会话投影版本发生变化时，再用当前 DSH 模型异步生成并缓存一条最新摘要，不会向原对话写入“总结”消息。

### 卡片与详情

- 卡片展示 Markdown 摘要、附件数量、工具调用数量、待办状态和实时回复。
- 支持将卡片标记为“重点”“关键结论”或“待验证”，使用与语义一致、无紫色倾向的状态配色帮助快速浏览画布。
- 每张卡片底部展示该轮会话的聚合性能信息，包括 LLM 用时、首 token、token 速率、缓存命中率以及输入/输出 token；多次模型调用只展示卡片级汇总，不拆分单次调用。
- 详情支持标题、段落、列表、表格、引用、链接、行内代码和代码块等 Markdown 内容。
- 支持展开普通工具过程，并内嵌展示 `dsh-artifact` 产物：
  - ECharts / ECharts-GL
  - Mermaid
  - `render_html` 沙箱画布
- 支持从任意回答位置创建 DSH 原生分支。
- 支持从 Atlas 中隐藏/删除卡片；该操作不会删除 DSH 原始 Session Log。

### 内嵌原生对话框

新会话卡片内提供与 DSH 原生输入区一致的会话级能力，无需返回线性对话页面：

- 直接读取 DSH 的完整模型目录，支持切换当前会话接入的不同厂商模型。
- 根据模型元数据选择推理等级。
- 支持“只读”“工作区写入”“全部权限”三种真实权限范围，并将选择同步到 DSH 当前会话。
- 输入 `/` 打开命令菜单，支持 `/status`、`/compact` 和 `/model`。
- 输入 `@` 打开上下文菜单，入口收敛为“选择本地文件”“对话历史”和“Skills”三类。
- 对话历史支持引用全部对话或多选单独的对话卡片；发送时注入所选卡片的真实用户/助手内容。
- Skills 列表读取 DSH 的真实可用技能，选择后以对应 `/skill-name` 命令交由 DSH Host 加载执行。
- 选择 PDF、`.docx`、`.xlsx/.xls`、CSV、文本、代码或配置文件作为本次消息上下文；卡片详情会显示文件名、类型和大小。
- `Enter` 发送，`Shift + Enter` 换行。
- 回复流式状态会同步回画布与详情。
- 模型、权限、命令和上下文菜单支持点击空白区域关闭；窄卡片下工具栏会自动切换为双行布局，避免按钮挤压或文本换行。

> 附件在浏览器本地解析：支持 PDF（仅含文本层）、`.docx`、`.xlsx/.xls`、CSV、文本、代码和配置文件。代码/配置文件以可读文本方式加入当前消息上下文，并标记为“代码/配置”；常见格式包括 Python、JavaScript/TypeScript、Java、Go、Rust、C/C++、C#、Shell、PowerShell、SQL、HTML/CSS、Vue、JSON、YAML、TOML、INI、Dockerfile 与 Makefile。单个文件最大 12 MB，单次合计最大 24 MB；每个文件最多提取 48,000 个字符，单次最多 96,000 个字符。提取后的正文会作为该轮消息上下文写入 DSH 历史，原始二进制文件不会上传或保存到 Atlas。扫描版 PDF 需先进行 OCR；旧版 `.doc` 暂不支持，请转换为 `.docx`。

### 外观与可用性

- 支持独立的深色/浅色画布切换。
- 卡片、详情、Markdown、菜单与 Artifact 会跟随当前 Atlas 主题。
- 支持卡片搜索、分支折叠、响应式布局和键盘操作。
- 画布拖拽期间禁止误选卡片正文，仍可在详情等明确的阅读区域正常选择文本。
- 卡片“更多”菜单使用适合内容密度的尺寸与点击区域，并可点击空白处关闭。

## 工作方式

```mermaid
flowchart LR
    DSH[DSH 会话历史] --> Atlas[Atlas 会话画布]
    Atlas --> Cards[对话卡片与分支]
    Atlas --> Summary[会话摘要]
    Atlas --> Native[继续使用 DSH 模型、命令与工具]
    Cards --> DSH
```

1. Atlas 读取当前工作区的 DSH 会话历史，并按一轮“提问 + 回答”生成卡片。
2. 从某条消息创建的 DSH 分支会在画布上保留为真实分支，而不是一份独立复制的对话。
3. 你在卡片详情中继续发送消息时，仍使用 DSH 当前会话的模型、工具和命令。
4. Atlas 将布局、卡片状态和摘要等辅助信息保存在本地；DSH 仍是原始对话历史的来源。

## 安装

### 环境要求

- 已安装并可以运行 DeepSeek Harness Web/Desktop。
- DSH 使用支持 Web profile 与社区插件的版本。
- 从源码开发时需要 Node.js `>= 22.19.0` 和 pnpm。

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:sumarilkkxx/dsh-atlas
dsh web
```

打开 DSH Web 页面后，点击页面顶部的 **卡片视图** 即可进入 Atlas。

### 从本地目录安装

克隆并构建项目：

```powershell
git clone https://github.com/sumarilkkxx/dsh-atlas.git
cd dsh-atlas
pnpm install
pnpm build
```

将本地目录链接到 DSH Web profile：

```powershell
dsh plugin --profile web add link:D:\path\to\dsh-atlas
dsh web
```

## 使用方式

1. 在 DSH 中打开任意已有会话。
2. 点击顶部 **卡片视图**。
3. 在左侧选择工作区和主会话；展开箭头可以查看分支子菜单。
4. 拖动卡片调整布局，使用滚轮/缩放按钮控制视口。
5. 点击卡片或右下角箭头打开详情。
6. 在新会话卡片中选择权限、模型、推理等级、本地文件、对话历史或 Skills，然后继续对话。
7. 点击 **返回对话** 可以随时切回 DSH 原生线性视图。

## 从源码运行

```powershell
pnpm install
pnpm dev
```

访问 Vite 输出的本地地址（通常是 `http://127.0.0.1:5173/`）可以查看独立 UI 预览。完整的 DSH 会话、模型与命令能力必须在插件挂载到 DSH 后验证。

常用命令：

```powershell
pnpm build     # 构建可安装的前端资源
pnpm preview   # 预览生产构建
```

> 不要直接双击 `dist/index.html`。Atlas 依赖同源 API 与 DSH 宿主上下文，构建产物需要通过 HTTP/DSH Web Server 加载。

## 项目结构

```text
dsh-atlas/
├─ client.js                 # DSH 浏览器端桥接与视图切换
├─ index.js                  # Host 插件、静态资源与 API 挂载
├─ cordis.patch.yml          # DSH Web profile 注入配置
├─ src/
│  ├─ app.tsx                # React 会话画布与内嵌输入框
│  ├─ index.css              # 主题、画布、卡片和菜单样式
│  ├─ lib/conversation-graph.js # 会话节点与性能指标聚合
│  └─ server/store.js        # SQLite 会话事件投影
├─ dist/                     # 可安装的生产前端资源
└─ docs/design/              # UI 设计规范参考
```

## 数据与安全边界

- DSH Session Log 始终是会话历史的唯一事实来源。
- Atlas 数据库默认位于 `$DSH_HOME/atlas/atlas.db`，保存展示投影、分支关系、卡片位置和版本化会话摘要。
- Atlas 不覆写或删除 DSH 原始历史；“删除卡片”只隐藏 Atlas 投影。
- 模型选择、推理等级、命令、Prompt 和 Fork 均通过 DSH 当前会话接口执行。
- 新会话卡片选择的权限范围会传递给 DSH Host；对话历史与本地文件只在用户明确选择后加入当轮上下文。
- 仅在打开或切换画布且摘要缓存已过期时，Atlas 会将压缩后的可见会话投影发送给当前选定模型生成摘要；摘要不会作为消息写回 DSH Session Log。
- `render_html` 使用受限 iframe 和 Content Security Policy，禁止外部网络、表单、对象和顶层导航。
- 默认仅允许同源/受信 Host 访问 Atlas API；额外 Host 可通过插件配置显式添加。

## 技术栈

- React 19 + TypeScript
- Vite 7
- Tailwind CSS 4
- Radix UI
- React Markdown + GFM
- SQLite（Node.js 内置 `node:sqlite`）
- DeepSeek Harness / Cordis 插件系统

## License

[MIT](./LICENSE)
