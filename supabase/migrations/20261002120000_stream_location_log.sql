create table if not exists public.stream_location_log (
  id bigserial primary key,
  nta_code text,
  neighborhood text,
  borough text,
  at timestamptz not null default now()
);
create index if not exists stream_location_log_at_idx on public.stream_location_log (at);
alter table public.stream_location_log enable row level security;
revoke all on public.stream_location_log from anon, authenticated;
