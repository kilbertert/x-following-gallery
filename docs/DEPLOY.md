# 部署指南

从零到一个线上的、边缘缓存的关注列表画廊。全程在**免费额度**内。
按顺序做，每步都有验证方式；任何一步失败都不要往下走。

预计耗时：45 分钟（其中 X 应用审核通常是即时的）。

---

## 第 0 步：先看演示版（1 分钟，不花钱）

```bash
cd ~/Projects/x-following-gallery    # 或你 clone 的位置
npm run demo && npm run preview
```

浏览器打开终端打印的地址。确认 UI 是你要的，再继续。

---

## 第 1 步：把 OAuth 回调发布到公网（本机是 frp 隧道）

本机是**无头服务器**，用不了 `http://localhost:PORT/callback`：X 不接受非 HTTPS 的
回调地址，而 localhost 回调只有"浏览器所在的那台机器"能收——不是这台。

本机已经有现成的 frp 反穿边缘（frps + nginx + Cloudflare 泛域名），直接复用，不另起一套：

```
浏览器 → https://xauth.ranlei.work   （Cloudflare 边缘 TLS，*.ranlei.work）
       → nginx 443（CF Origin 证书）
       → frps vhost :8188
       → frpc（systemd user 单元 x-following-gallery-frp.service）
       → 127.0.0.1:12110  ← scripts/x-authorize.mjs 在这里收 code
```

一条命令接好（幂等，可重复跑）：

```bash
./ops/wire-tunnel.sh
```

它会写入 `~/.config/frp/x-following-gallery.toml`（600）+ systemd 单元并拉起，然后打印：

- 回调地址 **`https://xauth.ranlei.work/callback`**
- 隧道 Basic Auth 的**用户名 / 密码**（授权时浏览器会弹框要求输入）
- 对应要填进 `.env` 的两行

> 端口 12110 已在 `~/Projects/DEVELOPMENT-PORT-REGISTRY.md` 登记为固定端点；
> `prod` 入口是 `xauth.ranlei.work`，Basic Auth 在隧道层。
> 不用了收摊：`systemctl --user disable --now x-following-gallery-frp.service`，
> 并在注册表里把该行 Lifecycle 改为 retired。

验证闸门（应为 `401`，说明 Basic Auth 已生效）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://xauth.ranlei.work/callback
```

---

## 第 2 步：X 开发者应用（拿 Client ID）

打开 <https://developer.x.com>，进入你的 App（没有就建一个）→
**User authentication settings → Set up**。按下面逐字段填（对照你的截图）：

| 字段（截图上） | 填什么 | 说明 |
|---|---|---|
| 应用权限 | **读取**（Read） | 只需要读自己的关注列表，不要选读写 |
| 向用户请求电子邮件 | **关**（保持截图里的灰/关） | 开了就要额外填隐私政策+服务条款 URL |
| 应用类型（必需的） | **原生应用 / 公共客户端** | 即 Public client + PKCE。**不要**选「Web 应用程序、自动化应用程序或机器人」（那是机密客户端，要 client secret） |
| 回调 URI / 重定向 URL（必需的） | `https://xauth.ranlei.work/callback` | **必须**与 `.env` 的 `X_REDIRECT_URI` 逐字符一致 |
| 网站网址（必需的） | `https://xauth.ranlei.work` | 该字段要求 https，且不接受 localhost、不接受裸 IP；留空会报错。先填这个隧道域名即可 |
| 组织名称 / 组织网址 | 留空 | 可选 |
| 服务条款 / 隐私政策 | 留空 | 上面的"请求电子邮件"关掉后就不强制；若被拦，可填 `https://xauth.ranlei.work/` |

保存后回到 **Keys and tokens**，复制 **OAuth 2.0 Client ID**：

```bash
cp .env.example .env
# 编辑 .env：
# X_CLIENT_ID=你复制的ClientID
# X_REDIRECT_URI 保持 https://xauth.ranlei.work/callback
```

**计费提醒**：X API 现在按量计费（credits）。本项目只用「Owned Reads」——
请求自己账号的数据，$0.001/资源。3000 个关注 ≈ $3/次全量同步。
同一资源 24 小时内重复请求只计一次。

### 验证

```bash
npm run authorize
```

终端会打印一条 `https://x.com/i/oauth2/authorize?...` 链接。**复制到你自己的电脑浏览器**
打开 → 用要备份的 X 账号登录 → 点授权 → 浏览器跳回 `xauth.ranlei.work`（会先弹 Basic Auth
账号密码框，填 `./ops/wire-tunnel.sh` 打印的那组）→ 显示「✅ 授权完成」即可关页面。

回到终端会看到 `✔ 授权成功，token 已写入 .env（权限 600）`。
`X_REFRESH_TOKEN` 会自动刷新，之后不用重复授权（除非你撤销授权或长期不用）。

> 隧道临时不通时，脚本支持兜底：把浏览器地址栏那一整条 URL 粘回终端回车即可。

---

## 第 3 步：第一次同步（验证连通性与计费）

```bash
npm run sync -- --dry-run     # 只抓 1 页，不上传图片、不写文件
```

应该看到：账号名、`共 N 个关注`、以及 `计费估算：N × $0.001 = $X`。
这一步先别用 `--no-media`，正式同步时需要 R2（下一步）。

> 如果这里报 `401`：重新跑 `npm run authorize`。
> 如果报 `429`：在限流退避，等一会儿自动重试（端点限额 300 次/15 分钟）。

---

## 第 4 步：Cloudflare R2（图片托管）

图片**必须**放这里：R2 免费额度是 10 GB 存储 + 1000 万次读/月 + **出网零费用**，
而且直读 R2 不消耗 Worker/Pages 的请求额度。

1. Cloudflare 控制台 → **R2** → **Create bucket**，名字 `x-following-gallery`。
2. 桶 **Settings** → **Public access** → 绑定一个**独立子域**（如 `img.ranlei.work`）。
   ⚠ **不要用 `xxx.r2.dev`**：它有限流，官方明说仅供开发调试。
3. **R2 → Manage R2 API Tokens → Create API Token**：
   - Permissions: **Object Read & Write**
   - 指定上一步那个桶
   - 创建后**立刻**记下 `Access Key ID` 和 `Secret Access Key`（只显示一次）
4. 在 Cloudflare 右侧栏复制 **Account ID**。
5. 补进 `.env`：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的account_id
R2_BUCKET=x-following-gallery
R2_ACCESS_KEY_ID=刚才的access_key
R2_SECRET_ACCESS_KEY=刚才的secret
R2_PUBLIC_DOMAIN=https://img.ranlei.work      # 末尾不要带斜杠
```

### 验证

```bash
npm run sync -- --limit 100     # 抓 100 个关注（2 页，约 $0.10）+ 上传图片
```

完成后打开 `https://img.ranlei.work/media/avatars/<某个id>-jpg.jpg`，
能看到头像就说明 R2 链路通了。

> **没有自定义域也能跑**：先把 `R2_PUBLIC_DOMAIN` 留空，`sync` 会把图片字段写成
> pbs.twimg.com 的原始 URL（热链）。能看，但不稳（URL 会轮换、可能被防盗链）。
> 等域名好了再跑一次 `npm run sync` 即可补上。

---

## 第 5 步：全量同步

```bash
npm run sync
```

会依次：抓全部关注 → 与 `site/data/archive.json` 对账（新增/变动/**移入赛博坟场**）
→ 镜像图片到 R2 → 生成 `archive.json`、`runtime-config.json`、`env-config.js`。
末尾打印计费估算。

**「赛博坟场」是怎么来的**：本次抓取的关注列表里没有、但归档里有的账号，会被标记
`archived_at` 并移入坟场——**不会被删除**。`--classify` 会额外为每个消失的账号调一次
状态查询，区分「取关 / 被封 / 已注销」（每个多计 $0.001）：

```bash
npm run sync -- --classify
```

---

## 第 6 步：发布到 Cloudflare Pages

1. 控制台 → **Workers & Pages → Create → Pages → Upload assets**（不要连 Git，
   本项目是直传）→ 项目名 `x-following-gallery`。
2. 建一个 API Token：**My Profile → API Tokens → Create Token → Custom token**：
   - `Cloudflare Pages` : **Edit**
   - `Account Settings` : **Read**
3. 填进 `.env`：`CLOUDFLARE_API_TOKEN=...`
4. 发布：

```bash
npm run publish
```

输出 `https://x-following-gallery.pages.dev`。到 Pages → **Custom domains** 绑一个子域，
例如 **`xfg.ranlei.work`**（`ranlei.work` 已在 Cloudflare DNS，直接加 CNAME 即可）。
好处：`*.pages.dev` 上没有 zone，用不了 Cache Rules；绑了自有域之后缓存策略才可配。

> **域的分工（两个独立子域，各司其职）：**
>
> | 用途 | 域 | 承载 | 计费 |
> |---|---|---|---|
> | 站点页面 | `xfg.ranlei.work` | Pages 静态资源（HTML/CSS/JS/JSON） | 免费、请求无限 |
> | 站点图片 | `img.ranlei.work` | R2 桶自定义域 | R2 Class B（1000 万/月免费） |
> | OAuth 回调 | `xauth.ranlei.work` | frp 隧道 → 本机 12110 | 仅授权时用 |
>
> 图片走**独立子域**而不是站点同域路径，是这个项目省额度设计的一半：图片请求只算 R2
> Class B，一点 Pages 请求额度都不吃；而且将来换 Pages 项目或换部署平台，图片 URL 不变。

⚠ **不要**在这个 Pages 项目上建 D1 数据库。参考站就是这样把自己烧到下午三点的
（原因见 [ARCHITECTURE.md](./ARCHITECTURE.md#为什么不用-d1)）。

---

## 第 7 步：定时同步

`sync` 是幂等、可重复跑的。挂到 cron 即可：

```cron
# 每天 04:17 同步一次（错开整点）
17 4 * * * cd /home/<你>/Projects/x-following-gallery && ./sync-daily.sh >> /tmp/xfg-sync.log 2>&1
```

**频率建议：每天到每周一次。** 官方 API 没有封号风险，但没必要的调用就是白花钱。

---

## 免费额度账本

| 资源 | 免费额度 | 本项目用量 |
|---|---|---|
| Pages 静态资源 | 请求**免费无限** | 全部 HTML/CSS/JS/JSON |
| Pages Functions | 无（本项目不用） | **0** |
| Workers 请求 | 10 万/天 | **0**（图片不经过 Worker） |
| D1 | 500 万行读/天 | **0**（不用 D1） |
| R2 存储 | 10 GB | 3000 头像+封面 ≈ 300–600 MB |
| R2 Class B 读 | 1000 万/月 | 每次图片请求 1 次 |
| X API | 按量 | **≈ $3 / 次全量同步** |

只要**不把图片塞进 Worker、不把数据塞进 D1**，这张表就不会红。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `npm run authorize` 报 state 不匹配 | 粘了旧链接。重新运行，用新打印的链接 |
| `sync` 报 401 | access token 失效且无 refresh token → 重跑 `npm run authorize` |
| `sync` 报 403 | 应用权限不是 `Read`，或 OAuth2 类型选成了 Confidential |
| 图片 404 | R2 未配置或其自定义域未生效；检查 `R2_PUBLIC_DOMAIN` 末尾无斜杠 |
| 线上是空画廊 | 忘了 `npm run sync`，或发布的是没带 `site/data/archive.json` 的目录 |
| 页面空白、控制台报 CSP | 站点 `_headers` 的 CSP 生效了，说明有内联脚本/未转义内容——别放宽 CSP，去修源头 |
| 卡片列数不对 / 有空白列 | 已修；若再出现，检查 `finalizeWall()` 的 `[data-tail]` 清理 |
