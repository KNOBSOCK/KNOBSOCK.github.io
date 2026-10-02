-- Keep only the public neighborhood label and timestamp. Never persist GPS coordinates.
create table if not exists public.stream_location (
  id smallint primary key default 1 check (id = 1),
  nta_code text,
  neighborhood text,
  borough text,
  updated_at timestamptz
);
alter table public.stream_location enable row level security;
revoke all on public.stream_location from anon, authenticated;
