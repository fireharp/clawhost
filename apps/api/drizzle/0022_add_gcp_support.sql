ALTER TABLE "ssh_keys" ADD COLUMN "gcp_key_id" integer;
ALTER TABLE "volumes" ADD COLUMN "provider_volume_ref" text;
