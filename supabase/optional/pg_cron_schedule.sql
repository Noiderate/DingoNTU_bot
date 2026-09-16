-- =============================================================================
-- OPTIONAL: schedule the bot's background jobs from inside Postgres.
--
-- NOT APPLIED AUTOMATICALLY. This lives outside supabase/migrations/ on purpose
-- so `supabase db push` ignores it. Only run it if you want to replace
-- cron-job.org with pg_cron.
--
-- The default setup uses cron-job.org calling /api/cron/tick once a minute,
-- because it has one advantage pg_cron cannot have: it keeps working when a
-- free-tier Supabase project pauses for inactivity. pg_cron stops with the
-- database, so it cannot wake the project back up.
--
-- Vercel Cron is not an option on the Hobby plan, which caps schedules at once
-- per day. On Pro you could use `crons` in vercel.json instead.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the secrets in Vault rather than inlining them here, so this file stays
-- safe to commit.
--
--   select vault.create_secret('https://your-project.vercel.app', 'bot_base_url');
--   select vault.create_secret('your-cron-secret',                'bot_cron_secret');

create or replace function call_bot_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_base_url text;
  v_secret   text;
begin
  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'bot_base_url';

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'bot_cron_secret';

  if v_base_url is null or v_secret is null then
    raise warning 'call_bot_tick: bot_base_url or bot_cron_secret missing from vault';
    return;
  end if;

  perform net.http_post(
    url     := v_base_url || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := '{}'::jsonb
  );
end;
$$;

-- Unschedule first so re-running this file does not create duplicate jobs.
select cron.unschedule('dingo-bot-tick')
  where exists (select 1 from cron.job where jobname = 'dingo-bot-tick');

select cron.schedule('dingo-bot-tick', '* * * * *', 'select call_bot_tick()');

-- Check it is running:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
