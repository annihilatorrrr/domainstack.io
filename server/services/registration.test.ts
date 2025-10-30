/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  lookup: vi.fn(async (_domain: string) => ({
    ok: true,
    error: null,
    record: {
      isRegistered: true,
      source: "rdap",
      registrar: { name: "GoDaddy" },
    },
  })),
}));

vi.mock("rdapper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rdapper")>();
  return {
    ...actual,
    lookup: hoisted.lookup,
  };
});

vi.mock("@/lib/domain-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-server")>();
  return {
    ...actual,
    toRegistrableDomain: (input: string) => {
      // Allow reserved TLDs for safe testing
      if (input.endsWith(".invalid") || input.endsWith(".test")) {
        return input.toLowerCase();
      }
      // Use real implementation for everything else
      return actual.toRegistrableDomain(input);
    },
  };
});

describe("getRegistration", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { makePGliteDb } = await import("@/lib/db/pglite");
    const { db } = await makePGliteDb();
    vi.doMock("@/lib/db/client", () => ({ db }));
    const { makeInMemoryRedis } = await import("@/lib/redis-mock");
    const impl = makeInMemoryRedis();
    vi.doMock("@/lib/redis", () => impl);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
  });

  it("returns cached record when present (DB fast-path, rdapper not called)", async () => {
    const { upsertDomain } = await import("@/lib/db/repos/domains");
    const { upsertRegistration } = await import("@/lib/db/repos/registrations");
    const { lookup } = await import("rdapper");
    const spy = lookup as unknown as import("vitest").Mock;
    spy.mockClear();

    const d = await upsertDomain({
      name: "example.com",
      tld: "com",
      unicodeName: "example.com",
    });
    await upsertRegistration({
      domainId: d.id,
      isRegistered: true,
      registry: "verisign",
      statuses: [],
      contacts: [],
      whoisServer: null,
      rdapServers: [],
      source: "rdap",
      fetchedAt: new Date("2024-01-01T00:00:00.000Z"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      transferLock: null,
      creationDate: null,
      updatedDate: null,
      expirationDate: null,
      deletionDate: null,
      registrarProviderId: null,
      resellerProviderId: null,
      nameservers: [],
    });

    const { getRegistration } = await import("./registration");
    const rec = await getRegistration("example.com");
    expect(rec.isRegistered).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    // Verify Redis cache was updated when hitting Postgres cache
    const { redis } = await import("@/lib/redis");
    const { getRegistrationCacheKey } = await import(
      "@/lib/db/repos/registrations"
    );
    const cached = await redis.get(getRegistrationCacheKey("example.com"));
    expect(cached).toBe("1"); // "1" means registered
  });

  it("loads via rdapper, creates registrar provider when missing, and caches", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
    const { getRegistration } = await import("./registration");
    const rec = await getRegistration("example.com");
    expect(rec.isRegistered).toBe(true);
    expect(rec.registrarProvider?.name).toBe("GoDaddy");

    // Verify provider row exists and is linked
    const { db } = await import("@/lib/db/client");
    const { domains, providers, registrations } = await import(
      "@/lib/db/schema"
    );
    const { eq } = await import("drizzle-orm");
    const d = await db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.name, "example.com"))
      .limit(1);
    const row = (
      await db
        .select({ registrarProviderId: registrations.registrarProviderId })
        .from(registrations)
        .where(eq(registrations.domainId, d[0].id))
        .limit(1)
    )[0];
    expect(row.registrarProviderId).toBeTruthy();
    const prov = (
      await db
        .select({ name: providers.name })
        .from(providers)
        .where(eq(providers.id, row.registrarProviderId as string))
        .limit(1)
    )[0];
    expect(prov?.name).toBe("GoDaddy");
  });

  it("caches unregistered domains in Redis only (not Postgres)", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
    const { lookup } = await import("rdapper");
    (lookup as unknown as import("vitest").Mock).mockResolvedValueOnce({
      ok: true,
      error: null,
      record: { isRegistered: false, source: "rdap" },
    });

    const { getRegistration } = await import("./registration");
    const rec = await getRegistration("unregistered.test");
    expect(rec.isRegistered).toBe(false);

    // Verify NOT stored in Postgres
    const { db } = await import("@/lib/db/client");
    const { domains } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const d = await db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.name, "unregistered.test"))
      .limit(1);
    expect(d.length).toBe(0);

    // Verify cached in Redis
    const { redis } = await import("@/lib/redis");
    const { getRegistrationCacheKey } = await import(
      "@/lib/db/repos/registrations"
    );
    const cached = await redis.get(
      getRegistrationCacheKey("unregistered.test"),
    );
    expect(cached).toBe("0"); // "0" means unregistered
  });

  it("returns cached unregistered status from Redis without calling rdapper", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();

    // Pre-cache unregistered status using the canonical helper
    const { REDIS_TTL_UNREGISTERED } = await import("@/lib/constants");
    const { setRegistrationStatusInCache } = await import(
      "@/lib/db/repos/registrations"
    );
    await setRegistrationStatusInCache(
      "cached-unregistered.test",
      false,
      REDIS_TTL_UNREGISTERED,
    );

    const { lookup } = await import("rdapper");
    const spy = lookup as unknown as import("vitest").Mock;
    spy.mockClear();

    const { getRegistration } = await import("./registration");
    const result = await getRegistration("cached-unregistered.test");

    // Should return a minimal Registration object with isRegistered: false
    expect(result).toMatchObject({
      domain: "cached-unregistered.test",
      tld: "test",
      isRegistered: false,
      source: null,
      registrarProvider: {
        name: null,
        domain: null,
      },
    });

    // rdapper should not have been called
    expect(spy).not.toHaveBeenCalled();
  });

  it("caches registered domains in both Redis and Postgres", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
    const { lookup } = await import("rdapper");
    (lookup as unknown as import("vitest").Mock).mockResolvedValueOnce({
      ok: true,
      error: null,
      record: {
        isRegistered: true,
        source: "rdap",
        registrar: { name: "Test Registrar" },
      },
    });

    const { getRegistration } = await import("./registration");
    const rec = await getRegistration("registered.test");
    expect(rec.isRegistered).toBe(true);

    // Verify stored in Postgres
    const { db } = await import("@/lib/db/client");
    const { domains, registrations } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const d = await db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.name, "registered.test"))
      .limit(1);
    expect(d.length).toBe(1);

    const reg = await db
      .select()
      .from(registrations)
      .where(eq(registrations.domainId, d[0].id))
      .limit(1);
    expect(reg.length).toBe(1);
    expect(reg[0].isRegistered).toBe(true);

    // Verify cached in Redis
    const { redis } = await import("@/lib/redis");
    const { getRegistrationCacheKey } = await import(
      "@/lib/db/repos/registrations"
    );
    const cached = await redis.get(getRegistrationCacheKey("registered.test"));
    expect(cached).toBe("1"); // "1" means registered
  });

  it("handles TLDs without WHOIS/RDAP gracefully (no server discovered)", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
    const { lookup } = await import("rdapper");

    // Simulate rdapper error for TLD without WHOIS server
    (lookup as unknown as import("vitest").Mock).mockResolvedValueOnce({
      ok: false,
      error:
        "No WHOIS server discovered for TLD 'ls'. This registry may not publish public WHOIS over port 43.",
      record: null,
    });

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { getRegistration } = await import("./registration");
    const rec = await getRegistration("whois.ls");

    // Should return minimal unregistered response
    expect(rec.domain).toBe("whois.ls");
    expect(rec.tld).toBe("ls");
    expect(rec.isRegistered).toBe(false);
    expect(rec.source).toBeNull();
    expect(rec.registrarProvider.name).toBeNull();
    expect(rec.registrarProvider.domain).toBeNull();

    // Should log as info (not error) since this is a known limitation
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[registration] unavailable"),
    );

    // Should NOT log as error
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("logs actual registration errors as errors (timeout, network failure)", async () => {
    const { resetInMemoryRedis } = await import("@/lib/redis-mock");
    resetInMemoryRedis();
    const { lookup } = await import("rdapper");

    // Simulate a real error (timeout, network failure, etc.)
    (lookup as unknown as import("vitest").Mock).mockResolvedValueOnce({
      ok: false,
      error: "Connection timeout after 5000ms",
      record: null,
    });

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => {});

    const { getRegistration } = await import("./registration");

    // Should throw error
    await expect(getRegistration("timeout.test")).rejects.toThrow(
      "Registration lookup failed for timeout.test: Connection timeout after 5000ms",
    );

    // Should log as error since this is unexpected
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[registration] error"),
      expect.any(Error),
    );

    // Should NOT log as info (unavailable)
    expect(consoleInfoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[registration] unavailable"),
    );

    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });
});
