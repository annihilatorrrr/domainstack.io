import { recordDomainAccess } from "@/lib/access";
import { toRegistrableDomain } from "@/lib/domain-server";
import { t } from "@/trpc/init";

/**
 * Middleware to record domain access for decay calculation.
 * Expects input to have a `domain` field containing the domain string.
 */
export const withAccess = t.middleware(async ({ input, next }) => {
  // Extract domain from input and record access if it's a valid registrable domain
  const domain =
    typeof input === "object" &&
    input !== null &&
    "domain" in input &&
    typeof input.domain === "string"
      ? input.domain
      : null;

  if (domain) {
    const registrable = toRegistrableDomain(domain);
    if (registrable) {
      recordDomainAccess(registrable);
    }
  }

  return next();
});
