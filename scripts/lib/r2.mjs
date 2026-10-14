/**
 * Cloudflare R2 uploader — hand-rolled AWS SigV4 over the S3-compatible API.
 *
 * Why hand-rolled: the host has no `aws` CLI, no `rclone`, and the only other
 * option is a heavy dependency. R2's S3 endpoint needs one PUT, so ~70 lines of
 * SigV4 beats installing a toolchain. The signer is generic and covered by an
 * AWS published known-answer test (see scripts/test/r2.test.mjs).
 */
import { createHash, createHmac } from 'node:crypto';

export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC3986 encoding — S3 wants '/' preserved in paths, encoded everywhere else. */
export const uriEncode = (s, keepSlash = false) =>
  String(s).split('').map((ch) => {
    if (/[A-Za-z0-9_.~-]/.test(ch)) return ch;
    if (ch === '/' && keepSlash) return ch;
    return Array.from(Buffer.from(ch, 'utf8')).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }).join('');

/**
 * Build the SigV4 signature for one request.
 * @param {{method,host,path,query?,headers,payloadHash,region,service,date}} req
 *   `date` is a Date; header keys are lowercased and trimmed.
 * @returns {{authorization:string, signedHeaders:string, canonicalRequest:string, stringToSign:string, amzDate:string}}
 */
export function signAwsV4(req) {
  const { method, host, path, payloadHash, region, service } = req;
  const date = req.date instanceof Date ? req.date : new Date(req.date);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8);

  const headers = { ...req.headers, host, 'x-amz-date': amzDate };
  const norm = (v) => String(v).trim().replace(/\s+/g, ' ');
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), norm(v)]));
  const signedHeaderNames = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${lower[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query = req.query || {};
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(decodeURIComponent(path), true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${req.secretKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    amzDate, signedHeaders, canonicalRequest, stringToSign, signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ------------------------------------------------------------------ client
export class R2Bucket {
  /**
   * @param {{accountId,accessKeyId,secretKey,bucket,fetchImpl?,log?}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.fetch = cfg.fetchImpl || fetch;
    this.log = cfg.log || (() => {});
    if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretKey || !cfg.bucket) {
      throw new Error('R2 配置不完整：需要 CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
    }
    this.host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  }

  async put(key, bytes, { contentType = 'application/octet-stream', immutable = true } = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const path = `/${this.cfg.bucket}/${key}`;
    const payloadHash = sha256hex(body);
    const headers = { 'content-type': contentType, 'x-amz-content-sha256': payloadHash };
    if (immutable) headers['cache-control'] = 'public, max-age=31536000, immutable';

    const sig = signAwsV4({
      method: 'PUT', host: this.host, path, headers, payloadHash,
      region: 'auto', service: 's3', date: new Date(),
      accessKeyId: this.cfg.accessKeyId, secretKey: this.cfg.secretKey,
    });

    const res = await this.fetch(`https://${this.host}${path}`, {
      method: 'PUT',
      headers: { ...headers, authorization: sig.authorization, 'x-amz-date': sig.amzDate },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`R2 PUT ${key} → HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return { key, bytes: body.length, contentType };
  }

  /** DELETE one object. Used to remove orphans left by a key-format change. */
  async delete(key) {
    const path = `/${this.cfg.bucket}/${key}`;
    const payloadHash = sha256hex('');
    const sig = signAwsV4({
      method: 'DELETE', host: this.host, path, headers: {}, payloadHash,
      region: 'auto', service: 's3', date: new Date(),
      accessKeyId: this.cfg.accessKeyId, secretKey: this.cfg.secretKey,
    });
    const res = await this.fetch(`https://${this.host}${path}`, {
      method: 'DELETE',
      headers: { authorization: sig.authorization, 'x-amz-date': sig.amzDate, 'x-amz-content-sha256': payloadHash },
    });
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → HTTP ${res.status}`);
  }

  /** HEAD an object so repeat syncs don't re-upload unchanged media. */
  async exists(key) {
    const path = `/${this.cfg.bucket}/${key}`;
    const payloadHash = sha256hex('');
    const sig = signAwsV4({
      method: 'HEAD', host: this.host, path, headers: {}, payloadHash,
      region: 'auto', service: 's3', date: new Date(),
      accessKeyId: this.cfg.accessKeyId, secretKey: this.cfg.secretKey,
    });
    const res = await this.fetch(`https://${this.host}${path}`, {
      method: 'HEAD',
      headers: { authorization: sig.authorization, 'x-amz-date': sig.amzDate, 'x-amz-content-sha256': payloadHash },
    });
    return res.ok;
  }
}

// ------------------------------------------------------------------ media mirror
/**
 * Download every planned avatar/banner and push it to R2.
 * twimg URLs must be fetched from this host (they 403 a browser referrer, and
 * their URLs rotate, which is why we re-host rather than hotlink).
 *
 * The content type comes from the plan (`planned.contentType`), not from the
 * object key: an object keyed `media/avatars/123.jpg` is fine, but a name like
 * `123-jpg` has no extension at the end of the path and would be stored as
 * application/octet-stream.
 *
 * @param {{bucket:R2Bucket, records:Array, fetchImpl?:Function, concurrency?:number, log?:Function}} opts
 * @returns {Promise<{uploaded:number, skipped:number, failed:Array, rewrites:Map}>}
 */
export async function mirrorMedia({ bucket, records, fetchImpl = fetch, concurrency = 6, log = () => {} }) {
  const jobs = [];
  for (const r of records) {
    for (const kind of ['avatar', 'cover']) {
      const planned = r[`_plan_${kind}`];
      if (planned?.rehost && planned.key) jobs.push({ id: r.id, kind, ...planned });
    }
  }

  const out = { uploaded: 0, skipped: 0, failed: [], rewrites: new Map() };
  let cursor = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const publicUrl = `${job.key.replace(/^media\//, '/media/')}`;
      try {
        if (await bucket.exists(job.key)) {                       // ponytail: HEAD per object; switch to a manifest diff if this ever dominates
          out.skipped++;
        } else {
          const res = await fetchImpl(job.src, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; x-following-gallery/1.0)', accept: 'image/*' },
          });
          if (res.status === 404) throw new Error(`源图 404（账号可能已删除或未设封面）`);
          if (!res.ok) throw new Error(`源图 HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 128) throw new Error(`源图过小（${buf.length}B）`);
          await bucket.put(job.key, buf, { contentType: job.contentType || 'image/jpeg' });
          out.uploaded++;
        }
        out.rewrites.set(`${job.id}:${job.kind}`, publicUrl);
      } catch (err) {
        out.failed.push({ id: job.id, kind: job.kind, src: job.src, error: err.message });
        log(`  ! ${job.kind} ${job.id} 失败：${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
  return out;
}

/** Delete objects by key — used to clean up orphans after a key-format change. */
export async function deleteObjects(bucket, keys, { concurrency = 8 } = {}) {
  let deleted = 0, failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try { await bucket.delete(key); deleted++; } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, worker));
  return { deleted, failed };
}

// ------------------------------------------------------------------ self-check
export function demo() {
  const assert = (c, m) => { if (!c) throw new Error('r2 self-check failed: ' + m); };
  assert(uriEncode('a b/c') === 'a%20b%2Fc', 'uriEncode escapes slash by default');
  assert(uriEncode('a b/c', true) === 'a%20b/c', 'uriEncode keeps slash when asked');
  const sig = signAwsV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    headers: {}, payloadHash: sha256hex(''), region: 'us-east-1', service: 's3',
    date: new Date('2013-05-24T00:00:00Z'), accessKeyId: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  assert(/^[0-9a-f]{64}$/.test(sig.signature), 'signature is 64 hex chars');
  assert(sig.canonicalRequest.startsWith('GET\n/test.txt\n'), 'canonical request shape');
  assert(sig.amzDate === '20130524T000000Z', 'amz date formatting');
  return 'r2.mjs self-check OK';
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(demo());
