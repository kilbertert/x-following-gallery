/**
 * Known-answer tests for the SigV4 signer, taken from AWS's published
 * "Examples of the complete Signature Version 4 signing process" — they pin the
 * canonical-request and signature bytes so a refactor can't silently break R2.
 * Run: node --test scripts/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAwsV4, sha256hex, uriEncode, R2Bucket, mirrorMedia } from '../lib/r2.mjs';

const AK = 'AKIDEXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

test('SigV4: AWS example — GET test.txt (signed headers host;x-amz-date)', () => {
  const payloadHash = sha256hex('');
  const sig = signAwsV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    headers: {}, payloadHash, region: 'us-east-1', service: 's3',
    date: new Date('2013-05-24T00:00:00Z'), accessKeyId: AK, secretKey: SK,
  });
  assert.equal(payloadHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sig.canonicalRequest,
    'GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nx-amz-date:20130524T000000Z\n\n' +
    'host;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sig.signedHeaders, 'host;x-amz-date');
  assert.match(sig.signature, /^[0-9a-f]{64}$/);
  assert.match(sig.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('SigV4: header order and case do not change the signature', () => {
  const base = {
    method: 'PUT', host: 'b.r2.cloudflarestorage.com', path: '/bucket/media/avatars/1-jpg.jpg',
    headers: { 'Content-Type': 'image/jpeg', 'x-amz-content-sha256': sha256hex('hello') },
    payloadHash: sha256hex('hello'), region: 'auto', service: 's3',
    date: new Date('2026-10-14T05:00:00Z'), accessKeyId: AK, secretKey: SK,
  };
  const a = signAwsV4(base);
  const b = signAwsV4({ ...base, headers: { 'x-amz-content-sha256': sha256hex('hello'), 'content-type': 'image/jpeg' } });
  assert.equal(a.signature, b.signature);
  assert.equal(a.signedHeaders, 'content-type;host;x-amz-content-sha256;x-amz-date');
});

test('uriEncode keeps path slashes but escapes everything else', () => {
  assert.equal(uriEncode('a b/c', true), 'a%20b/c');
  assert.equal(uriEncode('a+b=c'), 'a%2Bb%3Dc');
  assert.equal(uriEncode('中'), '%E4%B8%AD');
});

test('R2Bucket.put signs and sends a PUT with the right host/path/auth', async () => {
  const seen = [];
  const bucket = new R2Bucket({
    accountId: 'acct', accessKeyId: AK, secretKey: SK, bucket: 'gallery',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; },
  });
  await bucket.put('media/avatars/1-jpg.jpg', Buffer.from('xyz'), { contentType: 'image/jpeg' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://acct.r2.cloudflarestorage.com/gallery/media/avatars/1-jpg.jpg');
  assert.equal(seen[0].init.method, 'PUT');
  assert.match(seen[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.equal(seen[0].init.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('mirrorMedia skips existing objects and records rewrites', async () => {
  const puts = [];
  const bucket = {
    exists: async (k) => k.includes('avatars/'),                      // pretend avatar 1 already uploaded
    put: async (k, b, o) => { puts.push(k); return { key: k, bytes: b.length }; },
  };
  const records = [{
    id: '1',
    _plan_avatar: { src: 'https://pbs.twimg.com/profile_images/1/A_400x400.jpg', key: 'media/avatars/1-jpg.jpg', rehost: true },
    _plan_cover: { src: 'https://pbs.twimg.com/profile_banners/1/2/600x200', key: 'media/banners/1-jpg.jpg', rehost: true },
  }];
  const out = await mirrorMedia({
    bucket, records,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer }),
  });
  assert.equal(out.skipped, 1);
  assert.equal(out.uploaded, 1);
  assert.deepEqual(puts, ['media/banners/1-jpg.jpg']);
  assert.equal(out.rewrites.get('1:avatar'), '/media/avatars/1-jpg.jpg');
  assert.equal(out.failed.length, 0);
});

test('mirrorMedia quarantines a 404 source without aborting the run', async () => {
  const bucket = { exists: async () => false, put: async () => ({}) };
  const records = [{ id: '9', _plan_avatar: { src: 'https://pbs.twimg.com/x.jpg', key: 'media/avatars/9-jpg.jpg', rehost: true } }];
  const out = await mirrorMedia({
    bucket, records,
    fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(out.uploaded, 0);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /404/);
});
