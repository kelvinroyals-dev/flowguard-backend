BEGIN;
CREATE TABLE IF NOT EXISTS email_domain_events (
 id BIGSERIAL PRIMARY KEY,entity TEXT NOT NULL,entity_key TEXT NOT NULL,action TEXT NOT NULL,
 before_values JSONB NOT NULL DEFAULT '{}',after_values JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),processed_at TIMESTAMPTZ,last_error TEXT
);
CREATE INDEX IF NOT EXISTS email_domain_pending ON email_domain_events(id) WHERE processed_at IS NULL;
ALTER TABLE email_domain_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_domain_events ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE TABLE IF NOT EXISTS email_source_inventory(entity TEXT PRIMARY KEY,installed BOOLEAN NOT NULL);
CREATE TABLE IF NOT EXISTS email_webhook_events (
 id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,event_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_webhook_provider ON email_webhook_events(provider_id,event_at);
CREATE TABLE IF NOT EXISTS email_suppressions(recipient TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS email_worker_health(worker TEXT PRIMARY KEY,last_success_at TIMESTAMPTZ,last_failure_at TIMESTAMPTZ,error_code TEXT);
CREATE TABLE IF NOT EXISTS email_schedule_keys(key TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS backup_requested_at TIMESTAMPTZ;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS reminder_invoice_id VARCHAR(50);
ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_category_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_category_check CHECK(category IN ('transactional','security','alert','briefing','digest','activity'));

CREATE OR REPLACE FUNCTION capture_email_domain_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row JSONB;new_row JSONB;old_safe JSONB;new_safe JSONB;source_key TEXT;
 keys TEXT[]:=ARRAY['id','ticket_id','report_id','invoice_id','payment_id','sensor_id','alert_id','request_id','job_id','property_id','user_id','requested_by','submitted_by','author_id','author_type','role','user_type','account_owner_id','client_role','service_provider_org_id','sp_role','is_active','email','status','event_type','kind','reference','route','assigned_team','assigned_team_id','assigned_technician_id','scheduled_for','scheduled_date','sla_due_at','verification_submitted_at','approved_at','reject_reason','payment_status','amount','currency','balance_due','total_amount','next_due','active','tamper_flagged','geofence_state','lifecycle_state','created_at'];
BEGIN
 old_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 new_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO old_safe FROM jsonb_each(old_row) WHERE key=ANY(keys);
 SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO new_safe FROM jsonb_each(new_row) WHERE key=ANY(keys);
 IF TG_TABLE_NAME<>'users' THEN old_safe:=old_safe-'email';new_safe:=new_safe-'email';END IF;
 IF TG_TABLE_NAME='alerts' THEN old_safe:=old_safe||jsonb_build_object('backup_requested_at',old_row->'backup_requested_at');new_safe:=new_safe||jsonb_build_object('backup_requested_at',new_row->'backup_requested_at');END IF;
 IF TG_TABLE_NAME='sla_tracking' THEN
  old_safe:=old_safe||jsonb_build_object('breach_count',CASE WHEN jsonb_typeof(old_row->'sla_breaches')='array' THEN jsonb_array_length(old_row->'sla_breaches') ELSE 0 END);
  new_safe:=new_safe||jsonb_build_object('breach_count',CASE WHEN jsonb_typeof(new_row->'sla_breaches')='array' THEN jsonb_array_length(new_row->'sla_breaches') ELSE 0 END);
 END IF;
 IF TG_TABLE_NAME='users' THEN old_safe:=old_safe||jsonb_build_object('locked_until',old_row->'locked_until');new_safe:=new_safe||jsonb_build_object('locked_until',new_row->'locked_until');END IF;
 IF TG_TABLE_NAME='users' AND TG_OP='UPDATE' AND old_row->'password_hash' IS DISTINCT FROM new_row->'password_hash' THEN new_safe:=new_safe||'{"password_changed":true}'::jsonb;END IF;
 IF TG_OP='UPDATE' AND old_safe=new_safe THEN RETURN NEW;END IF;
 source_key:=COALESCE(new_row->>TG_ARGV[0],old_row->>TG_ARGV[0]);
 IF source_key IS NULL THEN RAISE EXCEPTION 'Email event source key unavailable: %',TG_TABLE_NAME;END IF;
 INSERT INTO email_domain_events(entity,entity_key,action,before_values,after_values)VALUES(TG_TABLE_NAME,source_key,TG_OP,old_safe,new_safe);
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
DO $$
DECLARE source RECORD;
BEGIN
 FOR source IN SELECT * FROM(VALUES
 ('service_requests','id'),('service_request_events','id'),('jobs','id'),('job_comments','id'),
 ('tickets','ticket_id'),('ticket_messages','id'),('inspection_reports','report_id'),
 ('service_provider_organisations','id'),('users','id'),('payments','payment_id'),('invoices','invoice_id'),
 ('service_plans','id'),('device_events','id'),('device_integrity_events','id'),('ingest_errors','id'),
 ('sla_tracking','id'),('alerts','alert_id'),('sensors','sensor_id')) AS s(entity,key_column)
 LOOP
  IF to_regclass(source.entity) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS email_domain_capture ON %I',source.entity);
   EXECUTE format('CREATE TRIGGER email_domain_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION capture_email_domain_event(%L)',source.entity,source.key_column);
   INSERT INTO email_source_inventory VALUES(source.entity,true) ON CONFLICT(entity)DO UPDATE SET installed=true;
  ELSE
   INSERT INTO email_source_inventory VALUES(source.entity,false) ON CONFLICT(entity)DO UPDATE SET installed=false;
  END IF;
 END LOOP;
END $$;
COMMIT;
