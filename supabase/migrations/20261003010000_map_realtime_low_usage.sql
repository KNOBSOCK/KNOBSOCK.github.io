grant select on public.stream_location to anon, authenticated;
drop policy if exists "Anyone can read the shared neighborhood" on public.stream_location;
create policy "Anyone can read the shared neighborhood" on public.stream_location for select to anon, authenticated using (true);
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stream_location'
  ) then
    alter publication supabase_realtime add table public.stream_location;
  end if;
end $$;

create table if not exists public.stream_heading_writer (
  id smallint primary key default 1 check (id = 1),
  token text not null,
  expires_at timestamptz not null
);
alter table public.stream_heading_writer enable row level security;
revoke all on public.stream_heading_writer from anon, authenticated;

create or replace function public.set_stream_heading(writer_token text, new_heading real)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean real;
begin
  if writer_token is null or length(writer_token) < 32 then
    return false;
  end if;
  if not exists (
    select 1 from public.stream_heading_writer
    where id = 1 and token = writer_token and expires_at > now()
  ) then
    return false;
  end if;
  if new_heading is not null and (new_heading < 0 or new_heading >= 360 or new_heading <> new_heading) then
    return false;
  end if;
  clean := case when new_heading is null then null else round(new_heading::numeric, 1)::real end;
  update public.stream_heading set heading = clean, updated_at = now() where id = 1;
  insert into public.stream_heading_log (heading, at) values (clean, now());
  return true;
end;
$$;
revoke all on function public.set_stream_heading(text, real) from public;
grant execute on function public.set_stream_heading(text, real) to anon, authenticated;
