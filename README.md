# x-following-gallery

把你自己的 **X (Twitter) 关注列表**备份成一个静态画廊站点：头像、Banner、简介、
粉丝数、认证状态、链接，以及——从关注列表里消失的账号（取关 / 被封 / 注销）会进
「赛博坟场」归档，**永不删除**。

形态参考 [nv-pu-sa.pages.dev](https://nv-pu-sa.pages.dev/)（「女菩萨 · X 博主精选画廊」），
但代码与架构是重新实现的：**零依赖、零构建、零后端**，数据是静态资源，图片走 R2 自定义域。

```
抓关注列表(官方 X API)  →  对账/归档(只增不减)  →  图片镜像 R2  →  site/data/archive.json
                                                                        ↓
                                    静态 SPA (Cloudflare Pages)  ←  边缘缓存
```

## 快速开始（不花钱、不填凭据）

```bash
cd ~/Projects/x-following-gallery    # 或你 clone 的位置

npm run demo        # 生成 48 条演示数据（内联 SVG 头像，完全离线）
npm run preview     # 打开 http://127.0.0.1:<随机端口>
npm test            # 6 条 SigV4 已知答案测试
```

预览即可体验全部功能：筛选分区、搜索、三档视图、抽卡、详情、双主题、快捷键。

## 真正跑起来

需要两个东西：**X 开发者账号**（免费注册，按量计费）和 **Cloudflare 账号**（免费额度足够）。
完整步骤见 **[docs/DEPLOY.md](docs/DEPLOY.md)**，这里是要点：

```bash
./ops/wire-tunnel.sh          # 把 OAuth 回调发布到 https://xauth.ranlei.work（复用本机 frp）

cp .env.example .env          # 填 X_CLIENT_ID（+ 后面得到的 R2/CF 变量）

npm run authorize             # 浏览器授权一次，token 自动写入 .env
npm run sync -- --dry-run     # 只抓 1 页，验证连通性、看计费估算
npm run sync                  # 全量同步 + 图片进 R2

npm run publish               # 发布到 Cloudflare Pages
```

> **本机没有浏览器**，所以 OAuth 回调不能填 `http://localhost/...`。`ops/wire-tunnel.sh`
> 复用这台服务器**已有的 frp 反穿边缘**（frps + nginx + Cloudflare 泛域名），把回调
> 发布成 `https://xauth.ranlei.work/callback`（隧道层带 Basic Auth），填进 X 开发者门户即可。

### 三个域的分工

| 用途 | 域 | 承载 | 计费 |
|---|---|---|---|
| 站点页面 | `xfg.ranlei.work` | Pages 静态资源 | 免费、请求无限 |
| 站点图片 | `img.ranlei.work` | R2 桶自定义域 | R2 Class B（1000 万/月免费） |
| OAuth 回调 | `xauth.ranlei.work` | frp → 本机 12110 | 仅授权时用 |

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run demo` | 生成演示数据（`--n 200` 调数量，`--force` 覆盖真实数据） |
| `npm run preview` | 本地预览（自动端口；`-- --port 13001` 固定端口，需先登记端口表） |
| `npm run authorize` | X OAuth2 PKCE 授权，写 token 到 `.env` |
| `npm run sync` | 全量同步（`-- --dry-run` / `-- --limit 200` / `-- --no-media` / `-- --classify`） |
| `npm run mirror-media` | **只**镜像图片到 R2（不碰 X API，不花 API 费用） |
| `npm run publish` | 发布到 Pages（`-- --project <name>`） |
| `npm test` | SigV4 签名已知答案测试 |

> `sync` 和 `mirror-media` 的分工：改关注列表要跑 `sync`（花 API 费用）；只是补图片、
> 换图片域、重传失败项就跑 `mirror-media`（零 API 费用，幂等）。

`sync` 的全部开关见文件头注释。计费估算每次同步都会打印——**Owned Reads 是
$0.001/资源**，3000 个关注一次全量约 $3。

## 目录
x-following-gallery/
├── site/                     # 部署产物（整目录上传，无构建步骤）
│   ├── index.html  app.js  style.css  logo-icon.svg
│   ├── _headers              # 严格 CSP —— 关掉参考站中过的 XSS 那一类风险
│   ├── env-config.js         # 生成物：R2 域名 / 账号 handle / 生成时间
│   ├── runtime-config.json   # 生成物：同上，供运行时读取
│   └── data/archive.json     # 生成物：归档数据（版本化的备份本体）
├── scripts/
│   ├── x-authorize.mjs       # 一次性 OAuth2 授权
│   ├── sync.mjs              # 主流程：抓取 → 对账 → 镜像 → 落盘
│   ├── demo-data.mjs         # 演示数据
│   ├── preview.mjs           # 本地静态服务（会应用 _headers 的 CSP）
│   ├── publish.mjs           # wrangler pages deploy 的薄封装
│   ├── lib/{x-api,archive,r2,config}.mjs
│   └── test/r2.test.mjs
└── docs/{DEPLOY.md,ARCHITECTURE.md}
```

## 设计取舍（为什么这么搭）

- **数据不放 D1。** D1 按扫描行数计费；参考站一条无索引查询就把每天 500 万行的免费
  额度烧到下午三点。只读数据直接做静态资源，免费且请求无限。
- **图片不经 Worker。** Worker 的缓存命中同样计一次请求，用它代理几千张图正是免费额度
  下午三点前耗尽的原因。R2 自定义域直读是 R2 Class B 操作（1 千万/月免费、出网免费）。
- **用官方 API，不碰 Cookie。** 脚本化登录会触发锁号风控；官方 Owned Reads 对自家数据
  $0.001/资源，3000 关注 ≈ $3/次，零封号风险。这是本实验最重要的一条：**备份工具不能
  成为封号的原因**。

细节与延伸阅读见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 合规与免责

- 站点展示的是**公开账号的公开资料**（头像/简介来自 X 公开页面），不含私密内容。
- 头像与 Banner 会镜像到**你自己的** R2 桶，请自行确认再发布是否符合 X 开发者政策、
  当地法律及版权要求；站点页脚保留了「仅为公开资料的技术性归档与索引系统」声明。
- API 计费、terms 与 tier 会变（2026 年已从订阅制改为按量 credits）。跑大批量同步前
  先用 `--limit` 小步验证。
- `.env`（含 token）已被 gitignore；**不要**提交、不要粘贴到任何公开处。
