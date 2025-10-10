import "server-only";

export async function launchChromium(
  overrides: Record<string, unknown> = {},
): Promise<import("puppeteer-core").Browser> {
  const isVercel = Boolean(process.env.VERCEL);

  // Always include a minimal set of stability flags; merge with env-specific args
  const stabilityArgs = [
    "--disable-dev-shm-usage", // avoid tiny /dev/shm; use /tmp instead
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const overrideArgs = (overrides as { args?: unknown }).args;
  const extraArgs = Array.isArray(overrideArgs)
    ? (overrideArgs as string[])
    : [];

  const { args: _ignoredArgs, ...restOverrides } = overrides as {
    args?: unknown;
    [key: string]: unknown;
  };

  if (isVercel) {
    // Vercel: use @sparticuz/chromium + puppeteer-core
    const chromium = (await import("@sparticuz/chromium")).default;
    const { launch } = await import("puppeteer-core");
    const executablePath = await chromium.executablePath();

    const baseArgs = Array.isArray(
      (chromium as unknown as { args?: unknown }).args,
    )
      ? (chromium.args as string[])
      : [];

    // Dedupe while preserving order: base -> stability -> overrides
    const seen = new Set<string>();
    const mergedArgs = [...baseArgs, ...stabilityArgs, ...extraArgs].filter(
      (arg) => {
        if (typeof arg !== "string") return false;
        if (seen.has(arg)) return false;
        seen.add(arg);
        return true;
      },
    );

    return launch({
      headless: true,
      args: mergedArgs,
      executablePath,
      defaultViewport: null,
      ...restOverrides,
    });
  }

  // Local development: prefer full puppeteer (bundled Chromium) if available,
  // otherwise fall back to puppeteer-core with a provided executable path.
  try {
    // Attempt to use full puppeteer locally for convenience
    const puppeteer = await import("puppeteer");
    const seen = new Set<string>();
    const mergedArgs = [...stabilityArgs, ...extraArgs].filter((arg) => {
      if (typeof arg !== "string") return false;
      if (seen.has(arg)) return false;
      seen.add(arg);
      return true;
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: mergedArgs,
      defaultViewport: null,
      ...restOverrides,
    } as never);
    return browser as unknown as import("puppeteer-core").Browser;
  } catch {
    // Fallback: require an explicit executable path for a locally installed Chrome/Chromium
    const { launch } = await import("puppeteer-core");
    const executablePath =
      (process.env.PUPPETEER_EXECUTABLE_PATH &&
        String(process.env.PUPPETEER_EXECUTABLE_PATH)) ||
      (process.env.CHROME_EXECUTABLE_PATH &&
        String(process.env.CHROME_EXECUTABLE_PATH)) ||
      undefined;

    if (!executablePath) {
      throw new Error(
        "Missing PUPPETEER_EXECUTABLE_PATH for local Chrome/Chromium. Install 'puppeteer' or set the env var.",
      );
    }

    const seen = new Set<string>();
    const mergedArgs = [...stabilityArgs, ...extraArgs].filter((arg) => {
      if (typeof arg !== "string") return false;
      if (seen.has(arg)) return false;
      seen.add(arg);
      return true;
    });

    return launch({
      headless: true,
      args: mergedArgs,
      executablePath,
      defaultViewport: null,
      ...restOverrides,
    });
  }
}
