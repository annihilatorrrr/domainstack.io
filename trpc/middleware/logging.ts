import { t } from "@/trpc/init";

export const withLogging = t.middleware(async ({ path, type, next }) => {
  const start = performance.now();
  console.debug(`[trpc] start ${path} (${type})`);
  try {
    const result = await next();
    const durationMs = Math.round(performance.now() - start);
    console.info(`[trpc] ok ${path} (${type}) ${durationMs}ms`);
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    console.error(
      `[trpc] error ${path} (${type}) ${durationMs}ms`,
      err instanceof Error ? err : new Error(String(err)),
    );
    throw err;
  }
});
