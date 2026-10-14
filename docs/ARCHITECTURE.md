# 架构与取舍

## 数据流

```
                    ┌──────────────────────────────────────────────┐
                    │  scripts/sync.mjs  (本机 / cron)              │
                    │                                              │
  X API v2  ────────┤ 1. OAuth2 用户上下文 → 读自己的 following      │
  (Owned Reads)     │ 2. reconcile(): 与上次归档对账                │
                    │      · 新账号   → 追加                        │
                    │      · 变动     → 更新字段                    │
                    │      · 消失账号 → 标记 archived_at（坟场）     │
                    │                    ★ 永不删除 ★              │
                    │ 3. 图片镜像 → R2 桶                           │
                    │ 4. 落盘 archive.json / runtime-config.json    │
                    └───────────────────┬──────────────────────────┘
                                        │
                     site/  ────────────┴──── 静态上传
                                        │
                    ┌───────────────────▼──────────────────────────┐
                    │  Cloudflare Pages（纯静态，无 Functions）      │
                    │  HTML/CSS/JS/JSON = 免费无限请求              │
                    └───────────────────┬──────────────────────────┘
                                        │  <img src="https://img.你的域/media/...">
                    ┌───────────────────▼──────────────────────────┐
                    │  R2 自定义域直读（Class B，1000万/月免费）     │
                    └──────────────────────────────────────────────┘
```

## 为什么不用 D1

参考站在更新日志里写「D1 数据库发现了严重的扫表问题，导致 D1 用量耗尽」。
机制是：**D1 按「扫描行数」计费，不是按返回行数**。一张几千行的表，一条没有索引的
`WHERE` 会全表扫描——每天 500 万行的免费额度，几轮请求就打满。

而画廊数据是**只读的、构建期就确定的**。静态资源请求在 Pages 上是**免费且无限**的。
所以这里连 D1 都不建：`archive.json` 就是一个静态文件，计数与筛选全在浏览器端做
（3000 条记录在浏览器里排序筛选是微秒级的）。

> 推论：任何「把只读数据放进计费型数据库」的设计都是同一个坑，与用 D1 还是别的无关。

## 为什么图片不经过 Worker

参考站用一个 `/api/media?key=...` Pages Function 代理 R2，加了
`cache-control: immutable` 让 CF 边缘缓存。这确实能缓存，但有一个致命点：
**Worker/Function 的缓存命中仍然计一次请求**（省的是 CPU，不是请求数）。
用 Worker 代理 3000 张头像 + 3000 张封面，等于把每一次图片浏览都算进
每天 10 万次的请求额度——这正是「早上 8 点撑到 15:30 就没用量」的直接原因。

改成 **R2 自定义域直读**后：

- 每次图片请求 = 1 次 R2 **Class B** 操作，额度 1000 万次/月（≈33 万次/天）；
- R2 **出网免费**；
- Pages 的请求额度**一次都不消耗**（图片不是 Pages 请求）。

CSP 里 `img-src` 放开了 `https:`，就是为了让浏览器直连图片域。

## 为什么抓取用官方 API 而不是 Cookie 爬虫

社区最成熟的方案是 `twscrape`（2026-10 仍在维护），它走 x.com 内部 GraphQL，
需要 `auth_token` + `ct0` Cookie。但：

1. **脚本化账密登录会锁号**（`DenyLoginSubtask`：「此账号被临时锁定」）；
2. **机房 IP 被风控**（社区反复出现 `ct0 not in cookies — most likely ip ban`，
   twscrape 自己也在推荐住宅代理）；
3. 内部 GraphQL 的 `queryId` 会随前端构建漂移，需要定期重新抓取。

这是个**备份工具**——它变成封号原因就本末倒置了。官方「Owned Reads」对自家账号
数据 $0.001/资源：3000 个关注一次全量 ≈ $3，零封号风险，字段齐全
（`profile_image_url` / `profile_banner_url` / `description` / `public_metrics` / `verified`）。

**备选**（如果官方计费再变）：`twscrape` + 自有住宅代理 + Cookie 会话（不要账密登录）。

## 备忘：核心正确性不变量

| 不变量 | 保障位置 |
|---|---|
| 归档只增不减：从关注列表消失的账号进坟场，**永不删除** | `lib/archive.mjs: reconcile()` |
| `backed_up_at` 是**首次**归档时间，跨同步保持不变 | `lib/archive.mjs: buildRecord()` |
| R2 对象 key 稳定（去掉 twimg URL 的 query），重复同步不重复上传 | `lib/archive.mjs: mediaPlan()` |
| 图片上传失败 → 回退热链，不会指向没写成功的对象 | `scripts/sync.mjs` 第 4 步 |
| 跨同步保留已改写的 `avatar_url` / `cover_url` | `buildRecord(..., prev, ...)` 的 `prev?.avatar_url` |
| 转义全部数据字段，CSP 关掉内联脚本 | `site/app.js: esc()` + `site/_headers` |
| 瀑布流不会残留空的尾列（导致多一列/布局变宽） | `site/app.js: finalizeWall()` 清理 `[data-tail]` |

## 为什么 OAuth 回调走 frp 而不是 localhost

X 的 OAuth2 只接受 **HTTPS** 回调，且拒绝 `http://localhost`。而本机是**无头服务器**——
localhost 回调只有"浏览器所在的机器"能接收，不是这台。所以回调必须发布到公网。

复用本机**已有的 frp 反穿边缘**（`frps` + nginx `*.ranlei.work` + Cloudflare 泛域名），
而不是另起 Cloudflare Tunnel / ngrok / 新证书链：

```
浏览器 → https://xauth.ranlei.work  (CF 边缘 TLS)
       → nginx 443 (CF Origin 证书)
       → frps vhost :8188
       → frpc (systemd user 单元)
       → 127.0.0.1:12110  ← x-authorize.mjs 收 code
```

- 固定端点，已登记进 `DEVELOPMENT-PORT-REGISTRY.md`（12110），关掉隧道时改 retired。
- 隧道层 `httpUser`/`httpPassword` 兜一道 Basic Auth——回调只在授权那一下被访问，
  多一道闸几乎零成本。
- frpc 的 `httpUser`/`httpPassword` **不支持 `{{ .Envs.X }}` 模板**（本机实测：模板会让
  proxy 起不来），所以密码是字面量、文件必须 600。`ops/wire-tunnel.sh` 幂等生成它。
- 手动兜底仍然保留：隧道临时不通时，把浏览器地址栏那整条 URL 粘回终端即可。

## 已知的刻意取舍

- **无框架、无构建。** `app.js` 是一个 IIFE，约 500 行。参考站也是手写的（89 KB），
  没有 React/Vite。对这类站点，构建步骤带来的复杂度大于收益。
- **计数在浏览器端算。** 「热度排行 425」这类数字随数据变化，前端用
  `slice(0, 425)` 算。参考站把它做成置顶逻辑，这里简化为「粉丝数前 425 = 热度」。
- **`mirrorMedia` 每个对象一次 HEAD** 来判断是否需要上传。
  `ponytail:` 若将来对象数上万导致耗时明显，改成一次性拉清单做差集。
- **`preview.mjs` 的 `_headers` 匹配是简化版 glob**（不支持 Pages 的 `:segment`
  语法），够用即可；CSP 是逐字节照搬的，所以本地能真实复现违规。
- **前端不请求任何分析端点。** 参考站有 `POST /api/track-click`（卡片点击计数），
  本实验去掉了：它需要后端、会消耗请求额度，而且没有明确收益。

## 参考站的逆向记录

参考站 `https://nv-pu-sa.pages.dev/` 的公开产物（用于对齐视觉与学习架构，**未复制代码**）：

- `index.html`：SPA 骨架 + `/api/config` + `env-config.js` + `app.js?v=3.0` + `style.css?v=3.0`
- `app.js`（89 KB，手写）：星空 canvas、柱状瀑布流、抽卡老虎机、时光档案抽屉、主题引擎
- `style.css`（125 KB）：`:root` 上是 OLED 黑（`--bg-app:#000`）+ 推特蓝
  （`--accent-primary:#38bdf8`）+ 金色（`#f59e0b`）+ 品红（`#ec4899`），以及香槟浅色主题
- 数据契约：`{id, screen_name, name, avatar_url, cover_url, followers_count, description,
  verified, backed_up_at, is_blocked, is_suspended, clicks_*}`，其中 `avatar_url` 形如
  `/api/media?key=avatars%2F<handle>_400x400.jpg`（单前缀，没有 `media/`——它自己的约定）
- 其公开 GitHub 仓库 `ethanaicode/nv-pu-sa` **只有数据镜像**（README + archive.json +
  refresh.sh），**无 license**，所以这里按可观测行为重新实现而不是复制。

本实验的 `archive.json` 契约在参考站字段基础上做了对齐与扩展：加了 `links` / `tags`
（前端从简介里抽链接做标签）、`following_count` / `tweets_count`、`removal_reason`
（坟场原因）、`sync_count` / `fingerprint`（变动检测），去掉了 `clicks_*`（无后端）。
