import { http, type Transport } from "viem";

const rateLimited = (failure: unknown) =>
  /over rate limit|rate.?limit|too many requests|\b429\b/i.test(String((failure as Error)?.message ?? failure));

/** One queue per operator, shared by reads and the transaction signer. */
export function queueRpc<T, R>(request: (args: T) => Promise<R>, options: {
  now?: () => number; wait?: (milliseconds: number) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let tail: Promise<unknown> = Promise.resolve();
  let lastStarted = -Infinity;
  return (args: T): Promise<R> => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        await wait(Math.max(0, 500 - (now() - lastStarted)));
        lastStarted = now();
        try { return await request(args); }
        catch (failure) {
          if (attempt >= 3 || !rateLimited(failure)) throw failure;
          // Replaying a signed raw transaction keeps its hash and nonce.
          await wait(2_000 * 2 ** attempt);
        }
      }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}

export function giwaTransport(url: string, alternateUrl?: string): Transport {
  const base = http(url, { timeout: 12_000, retryCount: 0 });
  const alternate = alternateUrl ? http(alternateUrl, { timeout: 8_000, retryCount: 0 }) : undefined;
  let queued: ReturnType<typeof queueRpc> | undefined;
  return options => {
    const transport = base(options);
    const fallback = alternate?.(options);
    queued ??= queueRpc(async input => {
      const args = input as Parameters<typeof transport.request>[0];
      try { return await transport.request(args); }
      catch (failure) {
        if (!fallback || (!rateLimited(failure) && !/TimeoutError|HttpRequestError/.test((failure as Error)?.name))) throw failure;
        return fallback.request(args);
      }
    });
    return { ...transport, request: queued as typeof transport.request };
  };
}
