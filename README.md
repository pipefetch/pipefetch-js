# pipefetch

YouTube transcripts, video details, channels, search and comments as JSON, from JavaScript.
This is the client for the [Pipefetch API](https://pipefetch.com).

- No dependencies. Works wherever `fetch` exists: Node.js 18+, Deno, Bun, Cloudflare Workers.
- TypeScript types included.
- You only pay for requests that return data. A video without captions or an empty search costs nothing.

```bash
npm install pipefetch
```

## Quick start

Create an API key at [pipefetch.com/dashboard](https://pipefetch.com/dashboard). A new account has
100 free credits and needs no card.

```js
import Pipefetch from 'pipefetch';

const pf = new Pipefetch(process.env.PIPEFETCH_API_KEY);

const transcript = await pf.transcript('https://www.youtube.com/watch?v=jNQXAC9IVRw');
console.log(transcript.title);
console.log(transcript.text);
```

`new Pipefetch()` without an argument reads the key from the `PIPEFETCH_API_KEY` environment variable.

## Methods

Each method is one request and returns the `data` of the answer. Videos can be given as an ID or
any YouTube URL; channels as a handle (`@mkbhd`), a channel ID or a channel URL.

| Method | Returns | Credits |
|---|---|---|
| `transcript(video, { lang, format, segments })` | Transcript as text, timed segments, SRT or WebVTT | 1 |
| `video(video)` | Exact views, likes, comment count, description, tags, chapters, channel | 1 |
| `channel(channel)` | Subscribers, video count, description, keywords, avatar | 1 |
| `channelVideos(channel, { limit })` | The latest uploads, up to 30, with views and duration | 1 |
| `channelShorts(channel, { limit })` | The latest Shorts, up to 40 | 1 |
| `search(query, { limit, type, sort, uploaded, country, lang })` | Search results, up to 40 | 1 |
| `comments(video, { limit, sort })` | Top or newest comments, up to 100 | 1 per started 20 |
| `account()` | The account's email and credit balance | free |

Every parameter and every field of the answers is in the [reference](https://pipefetch.com/docs).

```js
// A subtitle file
const srt = await pf.transcript('jNQXAC9IVRw', { format: 'srt', lang: 'en' });
await fs.promises.writeFile('subtitles.srt', srt.text);

// The latest uploads of a channel
const { channel, videos } = await pf.channelVideos('@mkbhd', { limit: 10 });
for (const video of videos) console.log(video.publishedAt, video.viewCount, video.title);

// Search, newest first, uploaded this week
const { results } = await pf.search('web scraping tutorial', { sort: 'newest', uploaded: 'week' });

// The top 40 comments (2 credits)
const { comments } = await pf.comments('jNQXAC9IVRw', { limit: 40 });
```

## Credits

After a request that returned data, `pf.credits` holds what it cost and what is left:

```js
await pf.video('jNQXAC9IVRw');
console.log(pf.credits); // { used: 1, remaining: 98 }
```

## Errors

Every error is a `PipefetchError` with the HTTP `status` and the API's `code`. No error is ever
charged. The common ones have their own classes:

| Class | Status | When |
|---|---|---|
| `NotFoundError` | 404 | YouTube has nothing to return: no such video, no captions, no results, comments turned off |
| `InvalidRequestError` | 400 | A parameter is missing, unknown or not allowed |
| `AuthenticationError` | 401 | The API key is missing or not valid |
| `InsufficientCreditsError` | 402 | The account has fewer credits than the request costs |
| `RateLimitError` | 429 | More than 120 requests in a minute, or too many requests today that found nothing |

```js
import Pipefetch, { NotFoundError } from 'pipefetch';

try {
  const transcript = await pf.transcript(videoId);
} catch (error) {
  if (error instanceof NotFoundError && error.code === 'no_transcript') {
    console.log('This video has no captions'); // not charged
  } else {
    throw error;
  }
}
```

Network failures, statuses 502, 503 and 504, and the per-minute rate limit are retried twice by
default, with a growing pause. Change that with the `retries` and `retryDelayMs` options.

## Options

```js
const pf = new Pipefetch({
  apiKey: 'pf_...',      // default: process.env.PIPEFETCH_API_KEY
  timeoutMs: 90_000,     // per request; answers are fetched live and usually take 2 to 7 seconds
  retries: 2,
  retryDelayMs: 1000,
});
```

## Keep the key on your server

Anyone who has your API key can spend its credits. Do not put it in code that runs in a browser:
call Pipefetch from your server or a serverless function and pass only the result to the page.

## Good to know

- Every answer is fetched live from YouTube, so the numbers are current and a request takes a few
  seconds.
- Each request returns one page: the latest 30 uploads, up to 40 search results, up to 100 comments.
- Pipefetch is an independent service. It is not affiliated with, endorsed by or sponsored by
  YouTube or Google.

## Links

- [Documentation](https://pipefetch.com/docs)
- [Guides](https://pipefetch.com/guides)
- [Pricing](https://pipefetch.com/pricing)
- Questions: support@pipefetch.com

MIT licensed.
