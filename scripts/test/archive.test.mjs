/**
 * Record-contract tests — the invariants that make the rendered links correct.
 *
 * These exist because a real defect shipped without any test failing: the
 * "访问 X" button pointed at the website in each profile (onlyfans / t.co)
 * instead of the account's X page. Every check at the time asserted "the page
 * rendered" — none asserted *where a link goes*. These do.
 *
 * Run: node --test scripts/test/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, mediaPlan } from '../lib/archive.mjs';

const NOW = '2026-10-14T00:00:00.000Z';
const apiUser = (extra = {}) => ({
  id: '42', username: 'creator', name: 'Creator',
  description: 'bio https://t.co/abc',
  profile_image_url: 'https://pbs.twimg.com/profile_images/42/A_normal.jpg',
  public_metrics: { followers_count: 1000, following_count: 5, tweet_count: 9 },
  ...extra,
});

test('profile_url is the X page, derived from the username', () => {
  const r = buildRecord(apiUser(), null, NOW);
  assert.equal(r.profile_url, 'https://x.com/creator');
});

test('profile_url never becomes a third-party site, even when the API url is one', () => {
  // The exact shape that caused the bug: the account's profile website is an
  // onlyfans link, exposed both as `url` and as entities.url.urls[0].
  const r = buildRecord(apiUser({
    url: 'https://onlyfans.com/creator',
    entities: { url: { urls: [{ expanded_url: 'https://onlyfans.com/creator' }] } },
  }), null, NOW);

  assert.equal(r.profile_url, 'https://x.com/creator', 'profile_url is the X page');
  assert.ok(!/onlyfans|t\.co/.test(r.profile_url), 'profile_url is not a third-party site');
  assert.equal(r.website_url, 'https://onlyfans.com/creator', 'the profile website is kept, separately named');
  assert.ok(!('url' in r), 'no field named `url` remains to be misread');
});

test('profile website prefers the expanded entities URL over the t.co shortlink', () => {
  const r = buildRecord(apiUser({
    url: 'https://t.co/short',
    entities: { url: { urls: [{ url: 'https://t.co/short', expanded_url: 'https://linktr.ee/creator' }] } },
  }), null, NOW);
  assert.equal(r.website_url, 'https://linktr.ee/creator');
});

test('a missing username-less profile link falls back to the id-stable page', () => {
  const r = buildRecord(apiUser({ username: 'x' }), null, NOW);
  assert.equal(r.profile_url, 'https://x.com/x');
});

test('media plan keys carry a real extension and a content type', () => {
  const p = mediaPlan('42', {
    profile_image_url: 'https://pbs.twimg.com/profile_images/42/A_normal.jpg',
    profile_banner_url: 'https://pbs.twimg.com/profile_banners/42/1',
  });
  assert.equal(p.avatar.key, 'media/avatars/42.jpg');
  assert.equal(p.avatar.contentType, 'image/jpeg');
  assert.equal(p.cover.key, 'media/banners/42.jpg');
  assert.ok(p.cover.src.endsWith('/600x200'));
});
