import z from "zod";

export const ProviderPricingSchema = z.object({
  provider: z.string(),
  price: z.string(),
});

export const PricingSchema = z.object({
  tld: z.string().nullable(),
  providers: z.array(ProviderPricingSchema),
});

export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
