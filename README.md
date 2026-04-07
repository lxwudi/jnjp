# Campus Switch Agent Console

校园交换机智能体节能控制台，提供前后端一体化能力：接口治理、智能体护栏、自治巡检、自动执行、统计分析与审计追踪。

## 项目定位

面向校园机房与网络运维场景，通过统一控制台实现：

- 识别低利用率或闲置端口
- 自动生成并执行节能策略
- 评估节电与减碳收益
- 保留完整操作链路用于审计

## 核心能力

- 自治智能体主控中心：护栏配置、自治巡检、策略规划、风险筛选、自动执行
- 接口数据中心：接口录入、CSV 导入、数据库持久化
- 可视化统计中心：趋势分析、策略占比、绿色收益
- 审计追踪中心：操作日志、执行记录、自治巡检留痕
- 权限体系：`admin` / `operator` / `auditor` 角色控制

## 技术栈

- 前端：`Vue 3` + `TypeScript` + `Vite`
- 后端：`Express 5` + `TypeScript`
- 智能体：`OpenAI Responses API` + function calling + 多角色协作编排
- 数据：控制台主数据与智能体作业均使用内建 `SQLite`
- 图形：SVG + CSS 工业控制大屏风格

## 系统架构

1. 数据接入层：接口录入、CSV 导入与数据库持久化
2. 策略层：智能体护栏、真实智能体规划、规则引擎兜底
3. 执行层：自治巡检、低风险自动放行、自动落库
4. 反馈层：统计回写、日志沉淀、收益展示

## 目录结构

- `src/`：前端主工程
- `src/views/`：多页面业务视图（总览/统计/自治/审计）
- `src/composables/useEnergyConsole.ts`：前端状态与 API 编排
- `src/types.ts`：前端类型定义
- `server/src/index.ts`：Express 服务入口
- `server/src/app.ts`：应用装配与中间件注册
- `server/src/routes/`：按业务域拆分的 REST 路由
- `server/src/services/`：状态存储、鉴权与业务服务
- `server/src/utils/`：节能计算、CSV 与响应工具
- `server/dist/`：后端 TypeScript 编译产物
- `server/data/console.db`：接口数据 SQLite 数据库
- `server/data/agent-runtime.db`：智能体作业与事件存储

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动后端

```bash
pnpm server
```

默认地址：`http://localhost:8787`

开发模式：

```bash
pnpm server:dev
```

### 3. 启动前端

```bash
pnpm dev
```

默认地址：`http://localhost:5173`

### 4. 构建检查

```bash
pnpm build
```

## 环境变量

前端：

- `VITE_API_BASE`：后端地址，默认 `http://localhost:8787`
- `VITE_API_USERNAME`：自动登录用户名，默认 `admin`
- `VITE_API_PASSWORD`：自动登录密码，默认 `admin123`

后端：

- `PORT`：服务端口，默认 `8787`
- `OPENAI_BASE_URL`：大模型兼容接口地址，默认留空；留空时走官方 OpenAI 地址
- `OPENAI_API_KEY`：启用真实智能体所需的 OpenAI API Key
- `OPENAI_MODEL`：智能体使用的模型，默认 `gpt-5.1`
- `OPENAI_REASONING_EFFORT`：推理强度，默认 `medium`
- `OPENAI_AGENT_MAX_TOOL_ROUNDS`：单次规划最多工具调用轮数，默认 `8`

说明：

- 后端现在会自动读取项目根目录 `.env` 中的这些变量
- 如果你接的是 OpenAI 兼容服务，请同时配置 `OPENAI_BASE_URL` 和 `OPENAI_API_KEY`
- 如果你接的是官方 OpenAI，只配 `OPENAI_API_KEY` 即可
- 现在也可以直接在前端“自治智能体主控台”里填写 Base URL、API Key、模型名和推理强度，保存后由后端落库使用

示例：

```bash
VITE_API_BASE=http://localhost:8787 \
VITE_API_USERNAME=operator \
VITE_API_PASSWORD=operator123 \
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=<your_key> \
OPENAI_MODEL=gpt-5.1 \
pnpm dev
```

也可以直接在项目根目录创建 `.env`：

```env
VITE_API_BASE=http://localhost:8787
VITE_API_USERNAME=admin
VITE_API_PASSWORD=admin123

PORT=8787
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-xxxxxxxx
OPENAI_MODEL=gpt-5.1
OPENAI_REASONING_EFFORT=medium
OPENAI_AGENT_MAX_TOOL_ROUNDS=8
```

## 默认账号

- `admin / admin123`：管理员（读写全部）
- `operator / operator123`：运维操作（业务执行）
- `auditor / auditor123`：审计角色（只读）

## 常用命令

- `pnpm dev`：启动前端开发服务
- `pnpm build`：前端构建 + 前后端 TypeScript 编译检查
- `pnpm build:server`：仅编译后端 TypeScript
- `pnpm preview`：预览构建结果
- `pnpm server`：编译后启动 Express 后端
- `pnpm server:dev`：后端热更新模式（`tsx watch`）

## API 概览

### 健康检查

- `GET /api/health`

### 鉴权

- `POST /api/auth/login`
- `GET /api/auth/me`

### 接口与数据接入

- `GET /api/interfaces`
- `POST /api/interfaces`
- `DELETE /api/interfaces`
- `POST /api/interfaces/import-csv`
- `POST /api/manual/analyze`（兼容保留的规则分析接口）
- `GET /api/advice`
- `POST /api/advice/:id/apply`
- `POST /api/advice/apply-all`

### 智能体护栏

- `GET /api/guardrails/config`
- `PUT /api/guardrails/config`
- `POST /api/guardrails/recommend-threshold`
- `POST /api/guardrails/toggle`
- `POST /api/guardrails/run`

### 自治智能体

- `GET /api/agents/status`
- `GET /api/agents/provider`
- `PUT /api/agents/provider`
- `GET /api/agents/autonomy`
- `PUT /api/agents/autonomy`
- `POST /api/agents/autonomy/run-now`
- `GET /api/agents/jobs?limit=20`
- `GET /api/agents/runs?limit=20`
- `POST /api/agents/plan`
- `POST /api/agents/plan/stream`
- `POST /api/agents/:id/execute`

### 统计与审计

- `GET /api/stats/overview`
- `GET /api/stats/trend`
- `GET /api/stats/compare`
- `GET /api/stats/eco`
- `GET /api/audit/logs`
- `POST /api/audit/logs/seed`
- `GET /api/reports/summary`

## 自治智能体调用示例

```bash
# 1) 登录
curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# 2) 查看自治配置
curl -s http://localhost:8787/api/agents/autonomy \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json'

# 3) 更新自治策略
curl -s -X PUT http://localhost:8787/api/agents/autonomy \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"intervalSeconds":60,"actionLimit":6}'
```

## 返回格式

- 成功：`{ "ok": true, "data": ... }`
- 失败：`{ "ok": false, "message": "...", "details": ... }`

## 数据持久化

- 接口池、建议、审计、执行记录、控制台配置会写入 `server/data/console.db`
- 智能体作业、阶段事件与执行链路会写入 `server/data/agent-runtime.db`
- 业务写操作只写数据库，不再依赖 JSON 状态文件
- 删除 `server/data/console.db` 后重启，系统会重新初始化控制台数据库
- 删除 `server/data/agent-runtime.db` 可清空智能体历史作业与事件记录

## 后端说明

- 当前后端已迁移为 `Express 5` + `TypeScript`
- REST API 路径与返回格式保持兼容，前端无需改接口调用方式
- 当前接口录入、CSV 导入和后续策略执行都会同步写入 `SQLite`
- CSV 仍保留为批量导入方式，但数据库才是接口数据的持久化载体
- 当前控制台状态数据已统一迁移到 `SQLite`，不再使用 JSON 状态文件
- 智能体规划已升级为基于 OpenAI `Responses API` + function calling 的真实工具型智能体
- 当前智能体链路为“规划智能体 + 风险评审智能体”双角色协作，支持流式进度回传
- 当前后端已支持“自治巡检 -> 风险筛选 -> 自动执行 -> 审计留痕”的全自动闭环
- 默认会按周期自动巡检；若未配置 `OPENAI_API_KEY`，可回退到规则引擎兜底
- 智能体作业与事件已独立落到 `SQLite`，便于查看历史运行过程和失败原因
- 若未配置 `OPENAI_API_KEY`，自治模式可按配置决定是否启用规则兜底；手动 `POST /api/agents/plan` 仍会拒绝执行

## 常见问题

- 智能体接入、DeepSeek 兼容、多实例冲突与作业残留等问题的完整排查记录，见 [docs/agent-bug-fixes.md](/Users/flx/Documents/jienengjianpai/docs/agent-bug-fixes.md)

### 前端无法连接后端

1. 确认后端已启动：`pnpm server`
2. 确认 `VITE_API_BASE` 配置正确
3. 查看浏览器控制台与后端日志

### 接口返回 401 / 403

- `401`：未登录或 token 过期
- `403`：当前账号权限不足

### 统计图为空

- 确认接口池里已有数据，并等待至少一轮自治巡检与执行完成后再查看统计页
