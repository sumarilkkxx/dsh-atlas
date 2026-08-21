# DSH Atlas

DSH Atlas 将 DeepSeek Harness 中连续的对话历史整理为可操作的卡片视图，帮助用户定位关键讨论、保留不同思路，并从原对话继续工作。

## 当前功能

- 按 DSH 工作目录归类会话，并与原生当前会话双向同步。
- 将每轮“用户问题 + 后续回答”整理为独立卡片；工具调用与结果收纳在对应回答中。
- 从任一问题卡片创建 DSH 原生分支，并连接到实际的分支位置。
- 在卡片详情中查看完整记录、展开工具过程、继续发送消息，或回到原生 DSH 对话。
- 拖动卡片、移动画布、缩放至 4 倍、定位当前会话与自动整理布局；卡片位置会保存在本地数据库。
- 折叠/展开后续节点；画布相机与折叠状态会保存在浏览器本地。
- 支持归档卡片（不会删除 DSH 原始会话）、搜索、实时回复显示，以及跟随 DSH 的深色主题。

## 开发

```powershell
pnpm install
pnpm dev
```

访问 Vite 输出的本地地址（通常为 `http://127.0.0.1:5173/`）。不要直接双击 `dist/index.html`，构建产物需要通过 HTTP 服务访问。

```powershell
pnpm build
pnpm preview
pnpm test
```

## 安装到 DSH

如果 `dsh` 已加入 PATH：

```powershell
dsh plugin --profile web add link:D:\harness_project\dsh-atlas
dsh web
```

DeepSeek Harness Desktop 未暴露全局 `dsh` 命令时，可直接使用桌面版内置 CLI（路径按实际安装目录调整）：

```powershell
node "D:\dsh_desktop\DeepSeek Harness\resources\host\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add "link:D:\harness_project\dsh-atlas"
node "D:\dsh_desktop\DeepSeek Harness\resources\host\node_modules\@deepseek-ai\dsh\lib\bin.js" web
```

打开 DSH Web 页面后，使用顶部的“卡片视图”进入 Atlas。

## 数据边界

- DSH 原始会话日志仍是唯一事实来源。
- Atlas 仅存储卡片位置与由已提交事件生成的展示数据。
- 默认数据库路径为 `$DSH_HOME/atlas/atlas.db`。
- Atlas 不修改模型请求、工具注册、权限或 DSH 原始历史。
