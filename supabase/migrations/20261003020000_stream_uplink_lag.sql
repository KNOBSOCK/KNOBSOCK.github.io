create table if not exists public.stream_uplink_lag (
  id smallint primary key default 1 check (id = 1),
  lag_ms integer,
  updated_at timestamptz
);
insert into public.stream_uplink_lag (id) values (1) on conflict (id) do nothing;
alter table public.stream_uplink_lag enable row level security;
revoke all on public.stream_uplink_lag from anon, authenticated;
grant select on public.stream_uplink_lag to anon, authenticated;
drop policy if exists anyone_reads_uplink_lag on public.stream_uplink_lag;
create policy anyone_reads_uplink_lag on public.stream_uplink_lag for select to anon, authenticated using (true);
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stream_uplink_lag'
  ) then
    alter publication supabase_realtime add table public.stream_uplink_lag;
  end if;
end $$;

create table if not exists public.stream_uplink_lag_log (
  id bigserial primary key,
  lag_ms integer,
  at timestamptz not null default now()
);
create index if not exists stream_uplink_lag_log_at_idx on public.stream_uplink_lag_log (at);
alter table public.stream_uplink_lag_log enable row level security;
revoke all on public.stream_uplink_lag_log from anon, authenticated;

create table if not exists public.stream_uplink_writer (
  id smallint primary key default 1 check (id = 1),
  token text not null
);
alter table public.stream_uplink_writer enable row level security;
revoke all on public.stream_uplink_writer from anon, authenticated;
insert into public.stream_uplink_writer (id, token)
values (1, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;

create or replace function public.set_stream_uplink_lag(writer_token text, new_lag_ms integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if writer_token is null or length(writer_token) < 32 then
    return false;
  end if;
  if not exists (select 1 from public.stream_uplink_writer where id = 1 and token = writer_token) then
    return false;
  end if;
  if new_lag_ms is not null and (new_lag_ms < 0 or new_lag_ms > 600000) then
    return false;
  end if;
  update public.stream_uplink_lag set lag_ms = new_lag_ms, updated_at = now() where id = 1;
  insert into public.stream_uplink_lag_log (lag_ms, at) values (new_lag_ms, now());
  return true;
end;
$$;
revoke all on function public.set_stream_uplink_lag(text, integer) from public;
grant execute on function public.set_stream_uplink_lag(text, integer) to anon, authenticated;

select token as uplink_key from public.stream_uplink_writer where id = 1;
