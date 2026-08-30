-- Forward-only Drizzle metadata checkpoint.
--
-- Migration SQL through 0030 already created this exact schema, while the
-- generated metadata chain stopped at 0024. The paired 0031 snapshot was
-- generated from the unchanged post-0030 TypeScript schema. This no-op keeps
-- fresh and upgrade databases byte-for-byte equivalent and prevents the next
-- generator run from replaying the 0025-0030 delta.
select 1;
