# Skillberry 工作台

在项目中创建任务，用 Agent 读写项目文件。一个项目对应一个持久化 Vercel Sandbox，一个任务对应一个 Claude Code Harness 会话。

## 本机运行

使用 Node.js 24 和 npm。在 `.env.local` 中配置 Vercel Sandbox 凭证和模型凭证。Sandbox 可用 `VERCEL_OIDC_TOKEN`，也可用 `VERCEL_TOKEN`、`VERCEL_TEAM_ID` 与 `VERCEL_PROJECT_ID`。模型使用 `AI_GATEWAY_API_KEY` 或 `ANTHROPIC_API_KEY`，默认 Claude Sonnet 4.6，也可选择 Claude Haiku 4.5。

```bash
npm ci
npm run dev -- --hostname 127.0.0.1
```

打开 [本机工作台](http://127.0.0.1:3000)。首版为单人内测，本机以回环地址运行。若放到共享网络，需要在工作台前增加访问控制。

项目和任务记录默认保存在 `.skillberry/workbench.sqlite`。可将 `SKILLBERRY_DATA_DIR` 指向有写入权限的持久化目录。项目文件和 Harness 运行时数据保存在 Vercel Sandbox 的文件系统中，暂停后的恢复受 Vercel 快照保留策略约束。重启应用时沿用同一数据库目录和 Vercel 项目。

## 验证

运行 `npm run lint`、`npx tsc --noEmit` 和 `npm run build`。真实执行场景及预期结果见 [MVP 需求文档](docs/agent-mvp-prd.md)。
