# ImgBed

基于 **Cloudflare Workers + R2 + D1** 的自托管图床，带完整 Web 管理界面。静态资源走 Cloudflare CDN，API 与图片直链由 Worker 处理。代码由AI完成90%以上（包括本自述文件）。


## 近期更新

- **图库搜索**：排序栏左侧排序、右侧搜索；支持当前目录即时过滤与全局 D1 搜索（扩展名 / 上传时间筛选）；全局结果展示路径并可跳转预览
- **上传队列**：右下角多文件队列，含缩略图、进度与「复制链接」；hash 本地并行计算 + `/api/check-hash` 预检，重复文件跳过上传；新文件上传成功后即时刷新目录
- **搜索与上传联动**：上传成功（含检测到重复）后自动退出搜索，回到当前目录视图
- **可配置提示时长**：管理页可设置上传成功 / 失败队列项停留秒数，保存后立即生效
- **部署说明**：Wrangler 4 要求 `wrangler.toml` 中 `name` 全小写；本地 `wrangler deploy` 的 Worker 名需与线上一致（如 `my-imgbed`），否则自定义域名不会更新到新代码

基于 **Cloudflare Workers + R2 + D1** 的自托管图床，带完整 Web 管理界面。静态资源走 Cloudflare CDN，API 与图片直链由 Worker 处理。代码由AI完成90%以上（包括本自述文件）。

![License](https://img.shields.io/badge/License-MIT-green.svg)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![R2](https://img.shields.io/badge/Storage-R2-0051C3)
![D1](https://img.shields.io/badge/Database-D1-0051C3)

## 特性

### 图库与预览

- 文件夹浏览、面包屑导航、排序（名称 / 时间 / 大小）
- **搜索**（与排序同一行：左排序、右搜索）
  - **当前目录**：输入即过滤，无需请求 API
  - **全局**：调用 `/api/search`，按 D1 文件名模糊匹配；可筛扩展名、上传日期；支持分页加载更多
  - 全局结果展示所在路径，点击跳转目录并打开预览
  - 点「筛选」可展开范围 / 类型 / 日期条件
- 图片预览：缩放拖拽、桌面 ESC 关闭、手机点击关闭
- 自适应布局：横图上下结构、竖图左右结构；信息区双栏展示
- 复制公开链接 / HTML / Markdown，一键下载
- EXIF 信息读取（JPEG、PNG、WebP 等）
- SVG 预览与 fallback 渲染

### 上传

- 按钮选择、**拖拽上传**、**粘贴剪贴板图片**、**粘贴图片 URL**
- 无后缀文件自动识别图片类型并补全扩展名
- 剪贴板图片统一转为 PNG 上传
- 基于 SHA-256 的**重复文件检测**
  - 浏览器本地算 hash，经 `/api/check-hash` 查 D1；已存在则**不上传**，直接返回已有链接
  - 服务端上传前仍会二次校验 hash，防止并发重复
- **上传队列**（右下角）：多文件一次展示完整队列，含缩略图、等待 / 校验 / 上传进度；成功可一键复制公开链接
  - 多文件 hash **并行校验**；前一个上传时，后续文件可同时在后台完成校验
  - 每张**新文件**上传成功后**立即刷新**当前目录
- **搜索中上传**：任意文件处理成功后自动退出搜索，回到正常目录列表
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
- **上传成功 / 失败提示时长**（秒，1–300，默认成功 3 秒、失败 5 秒）：控制队列项展示多久后自动消失，保存后立即作用于图库页
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
git clone https://github.com/iammsf/CFR2-ImageBed
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
name = "my-imgbed"              # Worker 名称（Wrangler 4 须全小写，字母/数字/连字符）

# 可选：绑定自定义域名（与 Dashboard 中该 Worker 的域名一致）
routes = [
  { pattern = "tuchuang.example.com", custom_domain = true }
]

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


### 搜索接口 `/api/search`

需 `perm_view`。在 D1 的 `items` 表上按**文件名**模糊匹配（不扫描 R2），仅返回 `type=file` 的记录。

**Query 参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 关键词，最长 200 字符 |
| `ext` | 否 | 扩展名过滤，如 `jpg`、`png`、`webp`（`jpg` 同时匹配 `.jpg` / `.jpeg`） |
| `from` | 否 | 上传时间下限（Unix 秒，`uploaded_at >= from`） |
| `to` | 否 | 上传时间上限（Unix 秒，`uploaded_at <= to`） |
| `parent` | 否 | 限定目录及其子目录，如 `/photos/2024` |
| `sort` | 否 | `uploaded_at`（默认，新→旧）、`name`、`size` |
| `limit` | 否 | 每页条数，默认 50，最大 100 |
| `offset` | 否 | 分页偏移，默认 0 |

**响应示例：**

```json
{
  "items": [{ "path": "a/b.jpg", "name": "b.jpg", "type": "file", "size": 12345, "uploaded_at": 1710000000 }],
  "total": 128,
  "limit": 50,
  "offset": 0,
  "q": "b"
}
```

图库页「当前目录」模式在前端本地过滤，不调用此接口；「全局」模式调用此接口，并支持加载更多（递增 `offset`）。

### Hash 查重接口 `/api/check-hash`

需 `perm_upload`。上传前由浏览器调用，在 D1 中按 SHA-256 批量查询是否已有相同文件，避免重复文件占用上行带宽。

**请求体（JSON）：**

```json
{ "hashes": ["<64位hex>", "..."] }
```

- 最多 100 个 hash
- 仅接受 64 位十六进制字符串

**响应示例：**

```json
{
  "matches": {
    "abc...": {
      "path": "photos/a.jpg",
      "name": "a.jpg",
      "url": "https://example.com/photos/a.jpg"
    }
  }
}
```

未命中的 hash 不会出现在 `matches` 中。实际上传仍走 `/api/upload`，服务端会再次校验 hash 后写入 R2。

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

**搜索不到刚上传或 R2 里已有的文件？**  
搜索依赖 D1 索引。若文件只在 R2 中、未写入 `items` 表，请先在管理页执行「同步索引」。

**改了代码但线上域名没变化？**  
确认 `wrangler.toml` 的 `name` 与 Cloudflare 上绑定该域名的 Worker 一致，然后在本机执行 `wrangler deploy`；部署后浏览器 **Ctrl + Shift + R** 强刷。若曾 deploy 到错误 Worker 名，需在 Dashboard 把自定义域名改绑到正确的 Worker。

**Wrangler 报 `name` 格式错误？**  
Wrangler 4 要求 Worker 名全小写，如 `my-imgbed`，不能使用 `CFR2-ImageBed` 这类大小写混写。

## 许可证

本项目采用 [MIT License](LICENSE) 开源，可自由使用、修改与分发，需保留版权声明。

## 致谢

部署在 Cloudflare 全球边缘网络上，享受 Workers 免运维与 R2 低成本对象存储。
