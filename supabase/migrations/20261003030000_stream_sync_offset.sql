create table if not exists public.stream_sync_offset (
  id smallint primary key default 1 check (id = 1),
  offset_ms integer,
  chunk_at timestamptz,
  quality real,
  updated_at timestamptz
);
insert into public.stream_sync_offset (id) values (1) on conflict (id) do nothing;
alter table public.stream_sync_offset enable row level security;
revoke all on public.stream_sync_offset from anon, authenticated;
grant select on public.stream_sync_offset to anon, authenticated;
drop policy if exists anyone_reads_sync_offset on public.stream_sync_offset;
create policy anyone_reads_sync_offset on public.stream_sync_offset for select to anon, authenticated using (true);
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stream_sync_offset'
  ) then
    alter publication supabase_realtime add table public.stream_sync_offset;
  end if;
end $$;

create table if not exists public.stream_sync_offset_log (
  id bigserial primary key,
  offset_ms integer not null,
  chunk_at timestamptz not null,
  quality real,
  at timestamptz not null default now()
);
create index if not exists stream_sync_offset_log_chunk_idx on public.stream_sync_offset_log (chunk_at);
alter table public.stream_sync_offset_log enable row level security;
revoke all on public.stream_sync_offset_log from anon, authenticated;

create or replace function public.set_stream_sync_offset(writer_token text, chunk_at_ms bigint, new_offset_ms integer, quality real)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  chunk_time timestamptz;
begin
  if writer_token is null or length(writer_token) < 32 then
    return false;
  end if;
  if not exists (select 1 from public.stream_uplink_writer where id = 1 and token = writer_token) then
    return false;
  end if;
  if new_offset_ms is null or new_offset_ms < -120000 or new_offset_ms > 120000 then
    return false;
  end if;
  chunk_time := to_timestamp(chunk_at_ms / 1000.0);
  if chunk_time < now() - interval '1 day' or chunk_time > now() + interval '1 hour' then
    return false;
  end if;
  update public.stream_sync_offset set offset_ms = new_offset_ms, chunk_at = chunk_time, quality = set_stream_sync_offset.quality, updated_at = now() where id = 1;
  insert into public.stream_sync_offset_log (offset_ms, chunk_at, quality) values (new_offset_ms, chunk_time, set_stream_sync_offset.quality);
  return true;
end;
$$;
revoke all on function public.set_stream_sync_offset(text, bigint, integer, real) from public;
grant execute on function public.set_stream_sync_offset(text, bigint, integer, real) to anon, authenticated;
