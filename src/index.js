/**
 * Pipefetch client for JavaScript: YouTube transcripts, videos, channels, search and comments as JSON.
 * No dependencies. Works wherever `fetch` exists: Node.js 18+, Deno, Bun, Cloudflare Workers.
 * Documentation: https://pipefetch.com/docs
 */

export const VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://pipefetch.com';
/** Statuses that mean "try again": the request was not charged and may succeed on a retry. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Any error answer from the API, or a failure to reach it. Nothing is charged for an error. */
export class PipefetchError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number | null, code?: string | null, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    /** HTTP status, or null when the API was not reached. */
    this.status = details.status ?? null;
    /** The API's error code, such as "no_transcript" or "insufficient_credits". */
    this.code = details.code ?? null;
  }
}
/** 400: a parameter is missing, unknown or not allowed. */
export class InvalidRequestError extends PipefetchError {}
/** 401: the API key is missing or not valid. */
export class AuthenticationError extends PipefetchError {}
/** 402: the account has fewer credits than the request costs. */
export class InsufficientCreditsError extends PipefetchError {}
/** 404: YouTube has nothing to return for this request (no such video, no captions, no results). Not charged. */
export class NotFoundError extends PipefetchError {}
/** 429: too many requests in a minute, or too many requests today that found nothing. */
export class RateLimitError extends PipefetchError {}

const ERROR_CLASSES = { 400: InvalidRequestError, 401: AuthenticationError, 402: InsufficientCreditsError, 404: NotFoundError, 429: RateLimitError };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Pipefetch {
  #apiKey;
  #baseUrl;
  #timeoutMs;
  #retries;
  #retryDelayMs;
  #fetch;

  /**
   * @param {string | { apiKey?: string, baseUrl?: string, timeoutMs?: number, retries?: number, retryDelayMs?: number, fetch?: typeof fetch }} [options]
   *   The API key, or an options object. Without a key, the PIPEFETCH_API_KEY environment variable is used.
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { apiKey: options } : options;
    const fromEnv = typeof process !== 'undefined' && process.env ? process.env.PIPEFETCH_API_KEY : undefined;
    this.#apiKey = opts.apiKey ?? fromEnv;
    if (!this.#apiKey) {
      throw new PipefetchError('Missing API key. Pass it to new Pipefetch() or set PIPEFETCH_API_KEY. Create one at https://pipefetch.com/dashboard');
    }
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Every answer is fetched live from YouTube and usually takes 2 to 7 seconds; 90 leaves room for a slow one.
    this.#timeoutMs = opts.timeoutMs ?? 90_000;
    this.#retries = opts.retries ?? 2;
    this.#retryDelayMs = opts.retryDelayMs ?? 1000;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new PipefetchError('No fetch function found. Use Node.js 18 or newer, or pass one as the fetch option.');
    /**
     * Credits used by the last request that returned data, and the balance after it.
     * @type {{ used: number, remaining: number } | null}
     */
    this.credits = null;
  }

  /** The transcript of a video: plain text, timed segments, or a ready SRT / WebVTT file. 1 credit. */
  transcript(video, options = {}) {
    return this.#get('/v1/youtube/transcript', { video, ...options });
  }

  /** Exact views, likes and comment count, description, tags, chapters and channel of one video. 1 credit. */
  video(video) {
    return this.#get('/v1/youtube/video', { video });
  }

  /** Subscribers, video count, description, keywords and avatar of a channel. 1 credit. */
  channel(channel) {
    return this.#get('/v1/youtube/channel', { channel });
  }

  /** The latest uploads of a channel, newest first (up to 30), with the channel itself. 1 credit. */
  channelVideos(channel, options = {}) {
    return this.#get('/v1/youtube/channel/videos', { channel, ...options });
  }

  /** The latest Shorts of a channel, newest first (up to 40). 1 credit. */
  channelShorts(channel, options = {}) {
    return this.#get('/v1/youtube/channel/shorts', { channel, ...options });
  }

  /** YouTube search results for a query (up to 40), with sorting and filters. 1 credit. */
  search(query, options = {}) {
    return this.#get('/v1/youtube/search', { q: query, ...options });
  }

  /** Top or newest comments of a video (up to 100). 1 credit per started 20 comments. */
  comments(video, options = {}) {
    return this.#get('/v1/youtube/comments', { video, ...options });
  }

  /** The account behind the key: its email and credit balance. Free. */
  account() {
    return this.#get('/v1/account', {});
  }

  async #get(path, params) {
    const url = new URL(this.#baseUrl + path);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    let lastError;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (attempt > 0) await sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      let response;
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { 'x-api-key': this.#apiKey, accept: 'application/json', 'user-agent': `pipefetch-js/${VERSION}` },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
        lastError = new PipefetchError(timedOut ? `No answer within ${this.#timeoutMs} ms.` : 'Could not reach the Pipefetch API.', { cause });
        continue;
      }
      const body = await response.json().catch(() => null);
      if (response.ok && body && 'data' in body) {
        if (body.credits) this.credits = body.credits;
        return body.data;
      }
      const code = body?.error?.code ?? null;
      const message = body?.error?.message ?? `The API answered ${response.status}.`;
      const ErrorClass = ERROR_CLASSES[response.status] ?? PipefetchError;
      lastError = new ErrorClass(message, { status: response.status, code });
      // Worth another try: trouble on the way to YouTube, or a short burst over the per-minute limit.
      const retryable = RETRYABLE_STATUS.has(response.status) || (response.status === 429 && code === 'rate_limited');
      if (!retryable) break;
    }
    throw lastError;
  }
}

export default Pipefetch;
