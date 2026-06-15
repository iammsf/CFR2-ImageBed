# ImgBed

基于 **Cloudflare Workers + R2 + D1** 的自托管图床，带完整 Web 管理界面。静态资源走 Cloudflare CDN，API 与图片直链由 Worker 处理。代码由AI完成90%以上。

![License](https://img.shields.io/badge/License-MIT-green.svg)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![R2](https://img.shields.io/badge/Storage-R2-0051C3)
![D1](https://img.shields.io/badge/Database-D1-0051C3)

## 特性

### 图库与预览

- 文件夹浏览、面包屑导航、排序（名称 / 时间 / 大小）
- 图片预览：缩放拖拽、桌面 ESC 关闭、手机点击关闭
- 自适应布局：横图上下结构、竖图左右结构；信息区双栏展示
- 复制公开链接 / HTML / Markdown，一键下载
- EXIF 信息读取（JPEG、PNG、WebP 等）
- SVG 预览与 fallback 渲染

### 上传

- 按钮选择、**拖拽上传**、**粘贴剪贴板图片**、**粘贴图片 URL**
- 无后缀文件自动识别图片类型并补全扩展名
- 剪贴板图片统一转为 PNG 上传
- 基于 SHA-256 的**重复文件检测**（已存在则提示并返回已有链接）
- 单文件最大 20MB，单次最多 100 个

### 文件管理

- 新建文件夹、移动、复制、重命名、删除
- 批量选择（手机底部工具栏 / 桌面 Ctrl·Shift 点选进入多选）
- 非管理员仅可删除自己上传的文件

### 权限与用户

| 权限 | 说明 |
|------|------|
| `perm_view` | 查看图库 |
| `perm_upload` | 上传、移动、复制、重命名、删除（受限于本人文件） |
| `perm_manage` | 进入管理页、删任意文件、同步索引等 |
| `admin` | 用户管理、全部权限 |

### 管理后台

- 站点标题、Logo、背景、页脚 HTML、R2 公开访问域名
- 用户增删与权限分配
- R2 → D1 索引同步（增量 / 全量）
- 设置导入 / 导出
- 登录 Fail2ban（窗口次数、封禁时长可配，0 = 永久封禁）

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 对象存储 | Cloudflare R2 |
| 元数据 | Cloudflare D1 (SQLite) |
| 前端 | 原生 HTML / CSS / JavaScript（无构建、无 Node 运行时） |
| 鉴权 | JWT（Cookie + Bearer） |
| 部署 | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI |

> **本项目线上不跑 Node.js。** Worker 在 Cloudflare 边缘执行，前端为纯静态文件。本地只有用 Wrangler 开发/部署时才需要 Node 环境（或使用 `npx wrangler` 免全局安装）。

## 项目结构

```
imgbed/
├── worker.js          # Worker 入口：API、R2 直链、鉴权
├── public/
│   ├── index.html
│   ├── app.js         # 前端逻辑
│   └── style.css
├── init.sql           # D1 初始化脚本
├── migrations/        # 旧库增量迁移 SQL
├── wrangler.toml      # Workers / R2 / D1 绑定
├── package.json       # 仅一键部署用（deploy 脚本与 JWT 说明，无 npm 依赖）
├── .dev.vars.example  # 本地密钥示例
└── LICENSE
```

## 快速开始

### 一键部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iammsf/CFR2-ImageBed)

适合不想本地装 Wrangler 的用户。点击后会：

1. 授权 Cloudflare / GitHub，在你的账号下 **Fork 一份仓库**
2. 按 `wrangler.toml` **自动创建** R2 桶、D1 数据库并绑定 Worker
3. 在向导里填写 **`JWT_SECRET`**（部署密钥）
4. 通过 Workers Builds **构建并部署**（含执行 `init.sql` 初始化表结构）
5. 打开分配的 `*.workers.dev` 地址，进入 **安装向导** 创建管理员

#### 一键部署注意事项

| 项目 | 说明 |
|------|------|
| 公开仓库 | 源仓库必须为 **Public**，否则他人无法使用此按钮 |
| Git 平台 | 仅支持 **GitHub / GitLab.com**（不支持 Gitee、自建 GitLab） |
| Fork 副本 | 部署会在 **你的 GitHub** 新建仓库，后续改代码推送到该仓库即可自动再部署 |
| `JWT_SECRET` | 在 Cloudflare 部署页填写，**不要**写进 `wrangler.toml` 或提交到 Git |
| D1 初始化 | 首次部署会通过 `package.json` 的 `deploy` 脚本执行 `init.sql`；若表已存在，重复执行一般无害（`IF NOT EXISTS`） |
| R2 公开访问 | 一键部署 **不会** 自动绑定自定义域名；安装向导或管理页填写 `r2_public_url`（R2 自定义域或 `*.r2.dev`） |
| 图片直链 | 未配置 `r2_public_url` 时，直链走 Worker 域名 `https://<worker>.workers.dev/<路径>` |
| 自定义域名 | 需在 Cloudflare Dashboard → Workers → 你的 Worker → **Domains** 中手动绑定 |
| 资源改名 | 向导里若修改 R2 桶名 / D1 名 / Worker 名，Cloudflare 会写回 Fork 仓库中的 `wrangler.toml` |
| 费用 | R2、D1、Workers 均有免费额度，超出按 [Cloudflare 定价](https://www.cloudflare.com/plans/) 计费 |

部署完成后若无法登录或页面异常，请到 Dashboard 确认 **Secrets** 中已有 `JWT_SECRET`，并访问 Worker 的 **Logs** 排查。

---

### 手动部署

适合需要完全掌控配置，或在本地调试的场景。

#### 1. 前置要求

- Cloudflare 账号
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（任选一种安装方式）：
  - 全局：`npm i -g wrangler`
  - 免安装：下文命令前加 `npx`（需本机有 Node.js）

#### 2. 获取代码

```bash
git clone <https://github.com/iammsf/CFR2-ImageBed>
cd imgbed
```

#### 3. 创建 Cloudflare 资源

1. **R2 存储桶**：Dashboard → R2 → Create bucket（例如 `images`）
2. **D1 数据库**：

   ```bash
   wrangler d1 create imgbed
   ```

   将返回的 `database_id` 填入 `wrangler.toml` 的 `[[d1_databases]]` 段。

3. **（可选）R2 公开域名**：为 bucket 绑定自定义域名或 `r2.dev` 子域，安装向导或管理页中填写 `r2_public_url`。

#### 4. 修改配置

编辑 `wrangler.toml`：

```toml
name = "my-imgbed"              # Worker 名称

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "images"          # 你的 R2 桶名

[[d1_databases]]
binding = "DB"
database_name = "imgbed"
database_id = "<你的 database_id>"
```

#### 5. 配置 JWT 密钥

**本地开发**：复制示例并填写随机长字符串

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置 JWT_SECRET=...
```

**生产环境**：

```bash
wrangler secret put JWT_SECRET
```

> 切勿将 `JWT_SECRET` 提交到 Git。`.dev.vars` 已在 `.gitignore` 中忽略。

#### 6. 初始化数据库

```bash
# 远程（生产）
wrangler d1 execute imgbed --remote --file=./init.sql

# 本地开发库
wrangler d1 execute imgbed --local --file=./init.sql
```

已有旧版本数据库时，可额外执行 `migrations/` 下对应 SQL；新部署通常只需 `init.sql`。Worker 启动时也会自动执行部分 schema 迁移。

#### 7. 部署

```bash
wrangler deploy
```

首次访问站点会进入**安装向导**：创建管理员账号并设置 R2 公开 URL。

#### 8. 本地开发

```bash
wrangler dev
```

浏览器打开 Wrangler 提示的本地地址即可调试。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_SECRET` | 是 | JWT 签名密钥，建议 32 字符以上随机字符串 |

通过 `.dev.vars`（本地）或 `wrangler secret put`（生产）注入，**不要**写进 `wrangler.toml`。

## API 概览

所有接口前缀为 `/api/`。除 `install-check`、`install`、`login` 外，均需登录（Cookie 或 `Authorization: Bearer <token>`）。

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/install-check` | GET | 是否需初始化 |
| `/api/install` | POST | 首次安装 |
| `/api/login` | POST | 登录 |
| `/api/bootstrap` | GET | 设置 + 当前目录文件列表 |
| `/api/files` | GET | 列出目录 |
| `/api/upload` | POST | 上传（multipart `files` + `targetDir`） |
| `/api/mkdir` | POST | 新建文件夹 |
| `/api/move` / `/api/copy` | POST | 移动 / 复制 |
| `/api/rename` | POST | 重命名 |
| `/api/delete` | POST | 删除 |
| `/api/manage-panel` | GET | 管理页数据 |
| `/api/settings` | GET/PUT | 站点设置 |
| `/api/refresh-index` | GET | R2 索引同步 |

图片直链：`https://<你的域名>/<对象 key>`，由 Worker 从 R2 读取并返回。

## 常见问题

**登录后空白页？**  
清除浏览器缓存后重试；若刚改过权限，请重新登录以刷新 JWT。

**粘贴 URL 上传失败？**  
目标站点未允许跨域时，浏览器无法直接 fetch，属 CORS 限制。可改用下载后拖拽上传。

**修改 `JWT_SECRET` 后**  
所有用户需重新登录。

**R2 与 D1 不一致**  
管理页执行「同步索引」，必要时使用全量模式。

## 许可证

本项目采用 [MIT License](LICENSE) 开源，可自由使用、修改与分发，需保留版权声明。

## 致谢

部署在 Cloudflare 全球边缘网络上，享受 Workers 免运维与 R2 低成本对象存储。
