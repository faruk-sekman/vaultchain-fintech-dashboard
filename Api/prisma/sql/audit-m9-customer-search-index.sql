-- audit M9 — trigram GIN indexes for case-insensitive customer search.
--
-- customers.service `list()` filters with `ILIKE '%term%'` on full_name / email / wallet_number
-- (Prisma `contains`, mode insensitive). A leading-wildcard ILIKE cannot use a b-tree index, so every
-- search is a sequential scan — acceptable at ~1500 rows, the slowest read path as the table grows.
-- A pg_trgm GIN index makes the substring search index-backed.
--
-- WHY A RAW-SQL OPS STEP (not schema.prisma): extension management + GIN(trigram) indexes are not
-- expressible in the schema without the `postgresqlExtensions` preview feature — so they are tracked
-- here and applied as a DB-ops step rather than through the Prisma migrations.
--
-- Apply (local dev DB or any environment), idempotent + lock-light:
--   psql "$DATABASE_URL" -f Api/prisma/sql/audit-m9-customer-search-index.sql
--   -- or: npx prisma db execute --file Api/prisma/sql/audit-m9-customer-search-index.sql --schema Api/prisma/schema.prisma
-- Note: CREATE EXTENSION requires a role with the privilege (the local postgres superuser has it).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS customers_full_name_trgm
  ON customers USING gin (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS customers_email_trgm
  ON customers USING gin (email gin_trgm_ops);
