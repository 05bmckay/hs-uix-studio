-- Bring-your-own Anthropic key + per-portal model choice.
-- Columns mirror the schema.sql installs definition; run once against
-- databases created before this feature (fresh DBs get them from schema.sql).
ALTER TABLE installs ADD COLUMN anthropic_key_enc BLOB;
ALTER TABLE installs ADD COLUMN anthropic_key_iv BLOB;
ALTER TABLE installs ADD COLUMN chat_model TEXT;
