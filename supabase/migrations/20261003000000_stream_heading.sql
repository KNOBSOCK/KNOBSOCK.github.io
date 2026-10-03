create table if not exists public.stream_heading (
  id smallint primary key default 1 check (id = 1),
  heading real,
  updated_at timestamptz
);
insert into public.stream_heading (id) values (1) on conflict (id) do nothing;
alter table public.stream_heading enable row level security;
revoke all on public.stream_heading from anon, authenticated;
grant select on public.stream_heading to anon, authenticated;
drop policy if exists "Anyone can read the stream heading" on public.stream_heading;
create policy "Anyone can read the stream heading" on public.stream_heading for select to anon, authenticated using (true);
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stream_heading'
  ) then
    alter publication supabase_realtime add table public.stream_heading;
  end if;
end $$;

create table if not exists public.stream_heading_log (
  id bigserial primary key,
  heading real,
  at timestamptz not null default now()
);
create index if not exists stream_heading_log_at_idx on public.stream_heading_log (at);
alter table public.stream_heading_log enable row level security;
revoke all on public.stream_heading_log from anon, authenticated;
