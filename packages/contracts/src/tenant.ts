import { z } from 'zod';

export const TenantStatus = z.enum(['active', 'suspended']);

export const Tenant = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: TenantStatus,
  workosLinked: z.boolean().optional(),
});
export type Tenant = z.infer<typeof Tenant>;

export const TenantsResponse = z.object({ tenants: z.array(Tenant) });
export type TenantsResponse = z.infer<typeof TenantsResponse>;

/** lowercase letters, digits, single dashes; no leading/trailing dash. */
export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits, and dashes');

export const ProvisionTenantRequest = z.object({
  name: z.string().trim().min(1).max(120),
  slug: SlugSchema.optional(),
  timezone: z.string().min(1).default('America/Los_Angeles'),
  adminEmail: z.string().trim().toLowerCase().email(),
});
export type ProvisionTenantRequest = z.infer<typeof ProvisionTenantRequest>;

export const LinkTenantWorkosRequest = z.object({
  adminEmail: z.string().trim().toLowerCase().email(),
});
export type LinkTenantWorkosRequest = z.infer<typeof LinkTenantWorkosRequest>;
