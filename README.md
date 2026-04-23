# ClipCap Word Production

一个基于 Next.js + Supabase + LLM 的文档模板自动填充系统。

它的核心流程是：

- 上传 `DOCX` 模板
- 抽取模板中的槽位
- 保存为可复用模板
- 批量上传 `PDF`
- 调用文本 / 视觉模型完成槽位回填
- 进入人工核查页确认结果
- 下载核查后的 `DOCX`

这个仓库目前已经包含：

- 邮箱登录
- 模板管理
- 批量生成任务
- 核查工作台
- Supabase Storage 文件管理
- 业务日志 `app_logs`

## 功能概览

- `DOCX 模板抽取`
  - 解析 Word 模板
  - 调用文本模型按段抽取槽位
  - 在槽位编辑页调整、删除、补充槽位
- `模板保存`
  - 将模板结构、HTML 预览、原始 DOCX 信息保存到 Supabase
- `批量 PDF 填充`
  - 为一个模板创建多个 PDF 子任务
  - 支持扫描件 PDF 的视觉模型识别
  - 支持结构化任务状态追踪
- `人工核查`
  - 左侧模板预览
  - 右侧 PDF 预览
  - 回填值编辑
  - 核查完成后下载最终 DOCX
- `任务与文件清理`
  - 支持删除单个任务
  - 支持删除模板并联动清理关联任务和存储文件
- `日志记录`
  - 登录发信
  - 任务创建 / 失败
  - 核查提交
  - 模板删除 / 任务删除

## 技术栈

- `Next.js 16`
- `React 19`
- `TypeScript`
- `Mantine 9`
- `TanStack Query`
- `Supabase`
- `Zod`
- `AI SDK / OpenAI-compatible API`
- `mammoth`
- `pdfjs-dist`
- `pdf-parse`

## 目录结构

```txt
src/
  app/           页面、API Route、类型定义
  components/    通用组件
  config/        配置
  hooks/         轻量前端 hooks
  lib/           领域逻辑、Supabase、LLM、文档处理
  modals/        Mantine modal 注册组件
  providers/     全局 provider
  querys/        React Query hooks
  stores/        前端状态
  styles/        全局样式
supabase/
  migrations/    数据库与 Storage 初始化 SQL
```

## 快速启动

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制一份环境变量文件：

```bash
cp .env.example .env.local
```

然后补齐 `.env.local` 中的配置：

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TEXT_LLM_API_KEY`
- `TEXT_LLM_BASE_URL`
- `TEXT_LLM_MODEL`
- `VISION_LLM_API_KEY`
- `VISION_LLM_BASE_URL`
- `VISION_LLM_MODEL`

如果你本地临时想跳过登录：

```env
NEXT_PUBLIC_BYPASS_LOGIN_FOR_LOCAL=true
```

如果需要真实邮箱登录：

```env
NEXT_PUBLIC_BYPASS_LOGIN_FOR_LOCAL=false
```

修改 `NEXT_PUBLIC_*` 环境变量后，请重启开发服务器。

### 3. 初始化 Supabase

按顺序执行以下 migration：

```txt
supabase/migrations/0001_initial.sql
supabase/migrations/0002_user_management.sql
supabase/migrations/0003_profile_registration.sql
supabase/migrations/0004_saved_templates_library.sql
supabase/migrations/0005_generation_storage.sql
supabase/migrations/0006_generation_tasks.sql
supabase/migrations/0007_app_logs.sql
```

如果你当前没有 Supabase CLI，可以直接在 Supabase Dashboard 的 `SQL Editor` 中按顺序执行。

### 4. 启动开发环境

```bash
pnpm dev
```

打开：

```txt
http://localhost:3000
```

## Supabase 说明

### 需要的数据库对象

- `public.profiles`
- `public.templates`
- `public.generation_tasks`
- `public.generation_task_items`
- `public.app_logs`

### Storage Bucket

项目会使用一个私有 bucket：

```txt
generation-pdfs
```

它用于保存：

- 用户上传的 PDF
- 批量任务相关文件

## 常用脚本

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm typecheck
```

## 开发说明

### 模板抽取

- `DOCX` 会先被解析为纯文本和 HTML
- 模板槽位抽取按段落进行
- 当前实现是“小批量并发抽取 + 最终按原文顺序还原”

### PDF 回填

- 文本型 PDF：走文本模型
- 扫描件 PDF：走视觉模型
- 回填结果写入 `generation_task_items.llm_output`
- 人工核查结果写入 `generation_task_items.review_payload`

### DOCX 下载

- 用户在核查页提交后
- 下载接口会基于模板原始结构生成核查后的 DOCX

## 调试

### 1. JSON 预览开关

在以下页面里：

- 槽位抽取页
- 槽位核查页

可以在浏览器控制台执行：

```js
window.clipcapJsonPreview.show()
window.clipcapJsonPreview.hide()
window.clipcapJsonPreview.toggle()
```

### 2. 测试 Doubao / Ark 模型

仓库中提供了一个简单脚本：

```txt
test_doubao_api.py
```

你可以直接在文件里填写：

- `ARK_BASE_URL`
- `ARK_API_KEY`
- `ARK_MODEL`

然后运行：

```bash
python .\test_doubao_api.py
```

用于验证某个模型当前是否可用。

## 日志

### 应用日志

业务日志存储在：

```txt
public.app_logs
```

目前会记录：

- 邮箱登录发起
- 批量任务创建
- PDF 处理成功 / 失败
- 核查提交
- 模板删除
- 任务删除

### 平台日志

如果部署到 Vercel：

- `Deployments` 查看构建日志
- `Functions / Logs` 查看运行时日志

## 部署建议

推荐部署方式：

- 前端与 API：`Vercel`
- 数据库与对象存储：`Supabase`
- 模型服务：兼容 OpenAI API 的文本 / 视觉模型服务

部署前请确认：

- 已配置所有环境变量
- Supabase migrations 已执行完成
- Storage bucket 已存在
- 视觉模型和文本模型账号可正常调用

## 适合的使用场景

- 法律文书模板填充
- 金融贷款 / 催收 / 仲裁材料整理
- 批量从 PDF 证据卷中提取结构化信息
- 人工核查后导出正式 Word 文档

## 注意事项

- 不要把真实 `API Key`、`Service Role Key` 提交到 GitHub
- `SUPABASE_SERVICE_ROLE_KEY` 只能在服务端使用
- 扫描件 PDF 的处理速度会明显慢于文本型 PDF
- 模型抽取结果仅供参考，必须结合 PDF 原文人工核查

## License

如果你准备开源，建议在仓库根目录补充一个 `LICENSE` 文件。

如果暂时不打算公开授权，可以先保留为私有仓库。
