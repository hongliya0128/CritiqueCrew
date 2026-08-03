# CritiqueCrew

CritiqueCrew 是一个基于 Figma Plugin API 与 TypeScript 开发的多视角界面评估插件。它能够读取当前选中的设计范围，执行自动化规则检测，并并行调用视觉设计、无障碍与交互设计三个评审角色，最后保留共识、判断差异和方向分歧，支持画布定位、问题标记以及 JSON、Markdown 导出。

## 运行环境

- Node.js 20 或更高版本
- npm
- Figma 桌面客户端（推荐用于本地开发插件）
- 真实模型评审：阿里云百炼兼容模式 API Key

## 安装与运行

### 1. 安装依赖

在本目录打开终端并运行：

```powershell
npm install
```

### 2. 创建本地配置

复制配置模板：

```powershell
Copy-Item .env.example .env
```

首次体验可以保留 `MOCK_LLM=true`。此模式不需要 API Key，会返回用于检查完整流程的模拟评审结果。

### 3. 启动插件构建与本地代理

```powershell
npm run dev
```

该命令会同时：

- 构建并持续更新 `dist/code.js` 与 `dist/ui.html`；
- 在 `http://localhost:8787` 启动本地代理服务。

终端出现 `CritiqueCrew proxy listening on http://localhost:8787` 后即可进入下一步。

### 4. 在 Figma 中安装

1. 打开 Figma 桌面客户端。
2. 进入任意设计文件。
3. 打开“插件”菜单中的“开发”。
4. 选择“从 manifest 导入插件”。
5. 选择本项目根目录下的 `manifest.json`。
6. 从“开发”插件列表运行 CritiqueCrew。

如果修改了源码，保持 `npm run dev` 运行并重新打开插件即可加载新构建。

## 配置真实百炼模型

编辑本地 `.env`：

```dotenv
LLM_PROVIDER=bailian
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen3.7-plus
PORT=8787
MOCK_LLM=false
```

保存后重新启动 `npm run dev`。插件顶部显示“百炼已连接”后，可以运行三位专家评审。

注意：

- 当前代码实现的模型提供方是阿里云百炼兼容接口，`LLM_PROVIDER` 请保持为 `bailian`。
- API Key 只由本地代理读取，不会写入 Figma 文档，也不会打包进插件界面。
- `.env` 已被 Git 忽略，请勿提交或分享该文件；可提交的只有不含密钥的 `.env.example`。
- 如需更换模型，只修改 `BAILIAN_MODEL`，并确认该模型支持兼容模式的对话接口和结构化输出。

可先单独检查模型连接：

```powershell
npm run test:model
```

## 日常使用

1. 在画布中选择一个 Frame、Component、Instance、Section 或 Group。
2. 点击“扫描选中范围”，查看颜色对比度、字号和点击区域等规则结果。
3. 点击“运行 AI 评审”，等待三位专家并行完成评审。
4. 展开专家卡片和总体评价，查看问题、定位节点或创建画布标记。
5. 导出 Markdown 或 JSON 完整评估结果。

当某个专家调用失败时，插件仍保留其他成功返回的视角，并将失败角色标记为“失败”；协调结果无法生成时，既有专家结果、共识、判断差异和方向分歧仍会保留。自动化规则检测不依赖模型，即使未配置 API Key 也可以正常使用。

## 生产构建与质量检查

生成可供 `manifest.json` 加载的构建产物：

```powershell
npm run build
```

只启动本地代理：

```powershell
npm run server
```

提交或交付前建议依次运行：

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

`dist/` 是构建产物，不纳入 Git。接收源码后需要先执行 `npm install` 和 `npm run build`。

## 目录说明

```text
src/main/       Figma 主线程：扫描、节点定位和画布标记
src/ui/         插件界面：流程控制、结果展示和导出
src/shared/     主线程、界面与服务端共享的类型和纯逻辑
server/         本地代理、百炼客户端、三专家评审与评审协调
tests/          规则、扫描、模型调用、并发、降级与导出测试
scripts/        构建和模型连接检查脚本
manifest.json   Figma 开发插件入口配置
```

三位专家在服务端通过并行任务同时请求；每个角色独立捕获错误。模型调用设置了超时，对限流和服务端异常自动重试一次，模型返回结构不合格时也会重新请求一次。

## 常见问题

### 插件显示“代理未连接”

确认 `npm run dev` 仍在运行，并访问 `http://localhost:8787/health` 检查本地代理。若修改过 `PORT`，还需要同步修改 `src/ui/api.ts` 中的代理地址以及 `manifest.json` 的开发域名配置。

### 没有配置 API Key

将 `MOCK_LLM=true` 可体验完整流程；要调用真实模型，填写 `DASHSCOPE_API_KEY` 并设置 `MOCK_LLM=false`，然后重启本地代理。

### 评审结果显示不完整

展开三位专家卡片查看具体失败原因。成功返回的专家结果不会被丢弃，可以在检查网络、模型名、余额或 API Key 后重新评审。

### Figma 找不到构建文件

先运行 `npm run build`，并确认存在 `dist/code.js` 和 `dist/ui.html`，再重新导入根目录的 `manifest.json`。
