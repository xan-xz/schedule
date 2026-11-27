-- Hosted Supabase setup. The portable migration supplies the outbox.
-- Store the project HTTPS origin and the worker credential in Vault first.
begin;

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.uf_telegram_wake_notifications()
returns bigint language plpgsql security definer set search_path='' as $$
declare project_url text; worker_secret text;
begin
  if not pg_try_advisory_xact_lock(44982040,2) or not exists (
    select 1 from public.uf_telegram_outbox o
    join public.uf_telegram_subscriptions s on s.chat_id=o.chat_id and s.binding=o.binding
    where o.state='pending' and o.available_at<=now() and o.attempts<8
      and greatest(o.original_date,o.payload->>'date') >= to_char(now() at time zone 'Asia/Almaty','YYYY-MM-DD')
      and s.group_id=o.group_id and (o.lease_until is null or o.lease_until<=now())
      and exists (
        select 1 from public.uf_platform p
        cross join lateral jsonb_array_elements(p.data->'groups') g(item)
        where p.id=1 and g.item->>'id'=s.group_id and public.uf_telegram_active_group(g.item)
      )
  ) then return null; end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name='uniflow_telegram_project_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name='uniflow_telegram_notification_secret';
  if not coalesce(project_url ~ '^https://[a-z0-9-]+[.]supabase[.]co$',false)
     or not coalesce(worker_secret ~ '^[A-Za-z0-9_-]{32,256}$',false) then return null; end if;

  return net.http_post(
    url=>project_url||'/functions/v1/telegram-notifications',
    headers=>jsonb_build_object('Content-Type','application/json','X-UniFlow-Notification-Secret',worker_secret),
    body=>'{}'::jsonb,timeout_milliseconds=>45000
  );
end;
$$;

revoke all on function public.uf_telegram_wake_notifications() from public,anon,authenticated;
grant execute on function public.uf_telegram_wake_notifications() to service_role;

select cron.schedule('uniflow-telegram-notification-retry','30 seconds',
  'select public.uf_telegram_wake_notifications()');
select cron.schedule('uniflow-telegram-notification-retention','17 1 * * *',
  'select public.uf_telegram_prune_notifications()');

commit;
