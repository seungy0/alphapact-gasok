import { http, type Transport } from "viem";

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
          const message = String((failure as Error)?.message ?? failure);
          if (attempt >= 3 || !/over rate limit|rate.?limit|too many requests|\b429\b/i.test(message)) throw failure;
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

export function giwaTransport(url: string): Transport {
  const base = http(url, { timeout: 12_000, retryCount: 0 });
  let queued: ReturnType<typeof queueRpc> | undefined;
  return options => {
    const transport = base(options);
    queued ??= queueRpc(args => transport.request(args as Parameters<typeof transport.request>[0]));
    return { ...transport, request: queued as typeof transport.request };
  };
}
