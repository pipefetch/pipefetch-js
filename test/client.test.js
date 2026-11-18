import assert from 'node:assert/strict';
import { test } from 'node:test';
import Pipefetch, {
  AuthenticationError, InsufficientCreditsError, InvalidRequestError, NotFoundError, Pipefetch as Named, PipefetchError, RateLimitError, VERSION,
} from '../src/index.js';

/** A fetch that answers from a queue and records what it was asked. */
function fakeFetch(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetch, calls };
}
const ok = (data, credits = { used: 1, remaining: 99 }) => ({ body: { data, credits } });
const error = (status, code, message = 'nope') => ({ status, body: { error: { code, message } } });
const client = (fake, options = {}) => new Pipefetch({ apiKey: 'pf_test', fetch: fake.fetch, retryDelayMs: 1, ...options });

test('the default and the named export are the same class', () => {
  assert.equal(Pipefetch, Named);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('a request sends the key in the header and returns the data', async () => {
  const fake = fakeFetch(ok({ videoId: 'jNQXAC9IVRw', text: 'All right' }));
  const pf = client(fake);
  const transcript = await pf.transcript('https://youtu.be/jNQXAC9IVRw', { lang: 'en', format: 'srt', segments: false });
  assert.deepEqual(transcript, { videoId: 'jNQXAC9IVRw', text: 'All right' });
  assert.deepEqual(pf.credits, { used: 1, remaining: 99 });
  const { url, init } = fake.calls[0];
  assert.equal(url.origin + url.pathname, 'https://pipefetch.com/v1/youtube/transcript');
  assert.deepEqual(Object.fromEntries(url.searchParams), { video: 'https://youtu.be/jNQXAC9IVRw', lang: 'en', format: 'srt', segments: 'false' });
  assert.equal(init.headers['x-api-key'], 'pf_test');
  assert.equal(init.headers['user-agent'], `pipefetch-js/${VERSION}`);
  assert.ok(!url.href.includes('pf_test'), 'the key never goes into the URL');
});

test('every method calls its endpoint with its parameters', async () => {
  const fake = fakeFetch(ok({}));
  const pf = client(fake);
  await pf.video('jNQXAC9IVRw');
  await pf.channel('@mkbhd');
  await pf.channelVideos('@mkbhd', { limit: 5 });
  await pf.channelShorts('@MrBeast');
  await pf.search('web scraping', { sort: 'newest', uploaded: 'week', limit: 40, country: undefined });
  await pf.comments('jNQXAC9IVRw', { limit: 100, sort: 'newest' });
  await pf.websiteContacts('apify.com', { pages: 3 });
  await pf.websiteBrand('https://stripe.com');
  await pf.instagramProfile('@nasa', { posts: false });
  await pf.account();
  assert.deepEqual(
    fake.calls.map((c) => c.url.pathname + c.url.search),
    [
      '/v1/youtube/video?video=jNQXAC9IVRw',
      '/v1/youtube/channel?channel=%40mkbhd',
      '/v1/youtube/channel/videos?channel=%40mkbhd&limit=5',
      '/v1/youtube/channel/shorts?channel=%40MrBeast',
      '/v1/youtube/search?q=web+scraping&sort=newest&uploaded=week&limit=40',
      '/v1/youtube/comments?video=jNQXAC9IVRw&limit=100&sort=newest',
      '/v1/web/contacts?url=apify.com&pages=3',
      '/v1/web/brand?url=https%3A%2F%2Fstripe.com',
      '/v1/instagram/profile?username=%40nasa&posts=false',
      '/v1/account',
    ],
  );
});

test('each kind of error answer becomes its own error class, with status and code', async () => {
  const cases = [
    [error(400, 'invalid_request'), InvalidRequestError],
    [error(401, 'unauthorized'), AuthenticationError],
    [error(402, 'insufficient_credits'), InsufficientCreditsError],
    [error(404, 'no_transcript', 'This video has no captions. Nothing was charged.'), NotFoundError],
    [error(429, 'not_found_limit'), RateLimitError],
  ];
  for (const [answer, ErrorClass] of cases) {
    const fake = fakeFetch(answer);
    await assert.rejects(client(fake).transcript('jNQXAC9IVRw'), (thrown) => {
      assert.ok(thrown instanceof ErrorClass && thrown instanceof PipefetchError);
      assert.equal(thrown.name, ErrorClass.name);
      assert.deepEqual([thrown.status, thrown.code], [answer.status, answer.body.error.code]);
      return true;
    });
    assert.equal(fake.calls.length, 1, `${answer.status} must not be retried`);
  }
});

test('trouble on the way is retried, then succeeds', async () => {
  const fake = fakeFetch(error(503, 'busy'), new TypeError('fetch failed'), error(429, 'rate_limited'), ok({ id: 'UC1' }));
  const pf = client(fake, { retries: 3 });
  assert.deepEqual(await pf.channel('@mkbhd'), { id: 'UC1' });
  assert.equal(fake.calls.length, 4);
});

test('when the retries run out, the last error is thrown', async () => {
  const busy = fakeFetch(error(502, 'upstream_error', 'YouTube did not answer.'));
  await assert.rejects(client(busy).video('jNQXAC9IVRw'), (thrown) => thrown instanceof PipefetchError && thrown.status === 502 && thrown.code === 'upstream_error');
  assert.equal(busy.calls.length, 3, 'one try and two retries by default');

  const offline = fakeFetch(new TypeError('fetch failed'));
  await assert.rejects(client(offline, { retries: 0 }).video('jNQXAC9IVRw'), (thrown) => thrown.status === null && /reach/.test(thrown.message) && thrown.cause instanceof TypeError);
  assert.equal(offline.calls.length, 1);
});

test('an answer that is not JSON is an error, not a crash', async () => {
  const fake = fakeFetch({ status: 500, body: '<html>oops</html>' });
  await assert.rejects(client(fake, { retries: 0 }).video('jNQXAC9IVRw'), (thrown) => thrown instanceof PipefetchError && thrown.status === 500 && thrown.code === null);
});

test('the key comes from the argument, the options or the environment, and is required', () => {
  const fake = fakeFetch(ok({}));
  assert.ok(new Pipefetch('pf_string') instanceof Pipefetch);
  const before = process.env.PIPEFETCH_API_KEY;
  delete process.env.PIPEFETCH_API_KEY;
  assert.throws(() => new Pipefetch({ fetch: fake.fetch }), /Missing API key/);
  process.env.PIPEFETCH_API_KEY = 'pf_env';
  assert.ok(new Pipefetch({ fetch: fake.fetch }) instanceof Pipefetch);
  if (before === undefined) delete process.env.PIPEFETCH_API_KEY;
  else process.env.PIPEFETCH_API_KEY = before;
});

test('a custom base URL is used without its trailing slash', async () => {
  const fake = fakeFetch(ok({}));
  await client(fake, { baseUrl: 'http://localhost:8787/' }).account();
  assert.equal(fake.calls[0].url.href, 'http://localhost:8787/v1/account');
});
