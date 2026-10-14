#!/usr/bin/env node
/**
 * One-time X OAuth2 authorization (PKCE).
 *
 * This host is headless and cannot use a `http://localhost:PORT/callback`
 * redirect: X rejects non-HTTPS redirect URIs, and a localhost callback is only
 * reachable from the machine the browser runs on — which is not this one.
 *
 * So the callback is published through this host's existing frp reverse tunnel:
 *
 *   browser → https://xauth.ranlei.work  (Cloudflare edge TLS, *.ranlei.work)
 *           → nginx 443 (CF Origin cert)
 *           → frps vhost :8188
 *           → frpc  (systemd user unit x-following-gallery-frp.service)
 *           → 127.0.0.1:12110  ← this script listens here
 *
 * The redirect URI registered on the X developer portal must be exactly
 * X_REDIRECT_URI (default https://xauth.ranlei.work/callback).
 *
 *   node scripts/x-authorize.mjs
 *   node scripts/x-authorize.mjs --local-port 12110     # if you moved the tunnel
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { buildAuthorizeUrl, pkcePair, requestToken } from './lib/x-api.mjs';
import { loadEnv, saveEnvVars, parseArgs, log, X_CREDS, redact } from './lib/config.mjs';

const args = parseArgs();
const env = loadEnv();
const creds = X_CREDS(env);

if (!creds.client_id) {
  console.error('✘ .env 里缺少 X_CLIENT_ID。');
  console.error('  先在 X 开发者门户建 OAuth2 应用、把回调填成 ' + (creds.redirect_uri || 'https://<子域>.ranlei.work/callback'));
  console.error('  然后把 Client ID 写进 .env：X_CLIENT_ID=xxxx');
  process.exit(1);
}

const redirectUrl = new URL(creds.redirect_uri);
if (redirectUrl.protocol !== 'https:') {
  console.error(`✘ X_REDIRECT_URI 必须是 https（当前 ${creds.redirect_uri}）。`);
  console.error('  X 不接受 http://localhost 回调——本机无浏览器，必须走 frp 公网回调。');
  console.error('  见 docs/DEPLOY.md 第 1 步。');
  process.exit(1);
}

// Where we actually bind. The frp tunnel forwards to 127.0.0.1:12110, so unless
// the redirect points straight at a localhost port we default to that.
const LOCAL_PORT = Number(args['local-port'] || env.X_CALLBACK_LOCAL_PORT || 12110);
const LOCAL_HOST = '127.0.0.1';
const CALLBACK_PATH = redirectUrl.pathname || '/callback';

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString('hex');
const authorizeUrl = buildAuthorizeUrl({
  clientId: creds.client_id, redirectUri: creds.redirect_uri, challenge, state,
});

log('\n──────────────────────────────────────────────────────────────');
log(' 在浏览器打开下面这条链接，用你要备份的 X 账号登录并点「授权」：');
log('──────────────────────────────────────────────────────────────\n');
log(authorizeUrl + '\n');
log(` 授权后 X 会把你跳到 ${creds.redirect_uri}?code=…&state=…`);
log(` 这条地址经 frp 隧道回到本机，本脚本正监听 ${LOCAL_HOST}:${LOCAL_PORT}；`);
log(' 浏览器那边会显示「授权完成」，你直接回到这个终端即可。\n');
log(' 若隧道没生效，脚本也会提示你改用手动粘贴回调 URL —— 两种方式都行。\n');

let done = false;
const finish = async (code, returnedState) => {
  if (done) return;
  if (!code) throw new Error('回调里没有 code');
  if (returnedState !== state) {
    throw new Error('state 不匹配 —— 可能不是本次授权的回调（CSRF 防护）。请重新运行本脚本');
  }
  const tok = await requestToken({
    clientId: creds.client_id, clientSecret: creds.client_secret,
    redirectUri: creds.redirect_uri, code, verifier,
  });
  saveEnvVars({
    X_ACCESS_TOKEN: tok.access_token,
    X_REFRESH_TOKEN: tok.refresh_token || '',
    X_EXPIRES_AT: String(tok.expires_at),
    X_SCOPE: tok.scope || '',
  });
  done = true;
  log('\n✔ 授权成功，token 已写入 .env（权限 600）');
  log(`  access_token  ${redact(tok.access_token)}`);
  log(`  refresh_token ${redact(tok.refresh_token)}`);
  log(`  scope         ${tok.scope}`);
  log('\n下一步：npm run sync -- --dry-run   （只抓 1 页，验证连通性）\n');
};

const successPage = (ok, msg) => `<!doctype html><meta charset="utf-8">
<title>X 授权</title>
<body style="font:16px/1.6 system-ui;background:#0a0a0d;color:#f8fafc;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:32rem;padding:2rem">
<div style="font-size:3rem">${ok ? '✅' : '⚠️'}</div>
<h2 style="margin:.4rem 0">${ok ? '授权完成' : '回调处理失败'}</h2>
<p style="color:#94a3b8">${msg}</p>
<p style="color:#64748b;font-size:.85rem">可以关闭本页面，回到运行脚本的终端。</p>
</div></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${LOCAL_HOST}:${LOCAL_PORT}`);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  const html = { 'content-type': 'text/html; charset=utf-8' };

  if (err) {
    const desc = url.searchParams.get('error_description') || '';
    res.writeHead(400, html).end(successPage(false, `X 返回了错误：${err} ${desc}`));
    console.error(`\n✘ X 拒绝了授权：${err} ${desc}`);
    console.error('  常见原因：回调 URL 与开发者门户登记的不一致，或应用权限/类型选错。');
    process.exit(1);
  }
  if (!code) {
    // Not the callback (browser prefetch, health check, …) — stay quiet and listening.
    res.writeHead(404, html).end(successPage(false, `等待回调中。请在 ${CALLBACK_PATH} 完成授权。`));
    return;
  }
  try {
    await finish(code, url.searchParams.get('state'));
    res.writeHead(200, html).end(successPage(true, 'token 已保存到服务器 .env'));
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, html).end(successPage(false, e.message));
    console.error('\n✘ 换取 token 失败：', e.message);
    process.exit(1);
  }
});

server.on('error', (e) => {
  console.error(`\n✘ 无法监听 ${LOCAL_HOST}:${LOCAL_PORT} —— ${e.message}`);
  console.error('  检查 frp 隧道与端口占用；或改用「手动粘贴」方式（下面仍可粘贴）。\n');
});

server.listen(LOCAL_PORT, LOCAL_HOST, () => {
  log(` 已监听 ${LOCAL_HOST}:${LOCAL_PORT}${CALLBACK_PATH}（等 X 回调）`);
  log(' 手动兜底：也可以把浏览器地址栏那一整条 URL 粘贴到下面回车。\n');
});

server.on('listening', () => {
  try {
    const a = server.address();
    log(` （实际绑定端口 ${a.port}）`);
  } catch { /* ignore */ }
});

// Manual fallback: paste the full callback URL (or the bare code).
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  const text = chunk.trim();
  if (!text) return;
  try {
    const m = text.match(/[?&]code=([^&\s]+)/);
    if (m) {
      await finish(decodeURIComponent(m[1]), new URL(text).searchParams.get('state'));
    } else {
      await finish(text, state);           // bare code: trust the local operator
    }
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('✘ 失败：', e.message);
    process.exit(1);
  }
});
process.stdin.resume();

setTimeout(() => {
  console.error('\n✘ 15 分钟内未收到授权，退出。');
  process.exit(1);
}, 900_000).unref?.();
