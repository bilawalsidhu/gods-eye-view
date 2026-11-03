create schema if not exists extensions;
create extension if not exists postgis with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create table private.role_assignments (
 user_id uuid primary key references auth.users on delete cascade,
 role text not null check (role in ('admin'))
);
alter table private.role_assignments enable row level security;
grant select on private.role_assignments to authenticated;
create policy own_role on private.role_assignments for select to authenticated using (user_id=(select auth.uid()));
create function public.is_mzansi_admin() returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from private.role_assignments where user_id=(select auth.uid()) and role='admin')
$$;
revoke all on function public.is_mzansi_admin() from public, anon;
grant execute on function public.is_mzansi_admin() to authenticated;
create table public.profiles (
 user_id uuid primary key default auth.uid() references auth.users on delete cascade,
 display_name text not null default '' check (length(display_name)<=100)
);
create table public.data_sources (
 id text primary key, name text not null, url text not null check (url like 'https://%'),
 attribution text not null, licence text not null, licence_url text not null,
 kind text not null check(kind in ('reference','live','simulated')), reviewed_at timestamptz not null,
 stale_after_days integer not null default 90 check(stale_after_days between 1 and 3650)
);
create table public.places (
 id uuid primary key default gen_random_uuid(), source_id text not null references public.data_sources,
 external_id text not null check(length(external_id) between 1 and 160),
 name text not null check(length(name) between 1 and 200),
 category text not null check(category in ('Venues','Transport','Health','Education','Public services','Infrastructure')),
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 location extensions.geography(Point,4326) generated always as (extensions.st_setsrid(extensions.st_makepoint(longitude,latitude),4326)::extensions.geography) stored,
 description text not null default '' check(length(description)<=2000),
 source_url text not null check(source_url like 'https://%'),
 observed_at timestamptz not null default now(), reviewed_at timestamptz,
 published boolean not null default false,
 unique(source_id,external_id)
);
create index places_location_idx on public.places using gist(location);
create index places_source_idx on public.places(source_id);
create table public.bookmarks (
 user_id uuid not null default auth.uid() references auth.users on delete cascade,
 place_id uuid not null references public.places on delete cascade,
 created_at timestamptz not null default now(), primary key(user_id,place_id)
);
create index bookmarks_place_idx on public.bookmarks(place_id);
create table public.saved_views (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users on delete cascade,
 name text not null check(length(name) between 1 and 100),
 longitude double precision not null check(longitude between -180 and 180),
 latitude double precision not null check(latitude between -90 and 90),
 height double precision not null check(height between 1 and 50000000),
 heading double precision not null check(heading between -7 and 7), pitch double precision not null check(pitch between -7 and 7), roll double precision not null check(roll between -7 and 7),
 filters jsonb not null default '{}' check(jsonb_typeof(filters)='object' and octet_length(filters::text)<=2000),
 created_at timestamptz not null default now()
);
create index saved_views_user_idx on public.saved_views(user_id);
create table private.import_runs (
 id uuid primary key default gen_random_uuid(), source_id text not null references public.data_sources,
 requested_by uuid references auth.users on delete set null,
 started_at timestamptz not null default now(), completed_at timestamptz,
 status text not null check(status in ('running','succeeded','failed')),
 row_count integer not null default 0, error text check(length(error)<=1000)
);
create index import_runs_source_idx on private.import_runs(source_id);
create index import_runs_user_idx on private.import_runs(requested_by);
alter table private.import_runs enable row level security;
grant select,insert,update on private.import_runs to authenticated;
create policy admin_imports on private.import_runs to authenticated using ((select public.is_mzansi_admin())) with check ((select public.is_mzansi_admin()));
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
alter table public.data_sources enable row level security;
revoke all on public.data_sources from anon, authenticated;
alter table public.places enable row level security;
revoke all on public.places from anon, authenticated;
alter table public.bookmarks enable row level security;
revoke all on public.bookmarks from anon, authenticated;
alter table public.saved_views enable row level security;
revoke all on public.saved_views from anon, authenticated;
grant select,insert,update,delete on public.profiles to authenticated;
create policy own_records on public.profiles to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update,delete on public.bookmarks to authenticated;
create policy own_records on public.bookmarks to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select,insert,update,delete on public.saved_views to authenticated;
create policy own_records on public.saved_views to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
grant select on public.data_sources, public.places to anon, authenticated;
grant insert,update,delete on public.data_sources,public.places to authenticated;
create policy source_read on public.data_sources for select to anon,authenticated using (true);
create policy place_read on public.places for select to anon,authenticated using (published);
create policy admin_manage on public.data_sources to authenticated using ((select public.is_mzansi_admin())) with check ((select public.is_mzansi_admin()));
create policy admin_manage on public.places to authenticated using ((select public.is_mzansi_admin())) with check ((select public.is_mzansi_admin()));
create function public.nearby_places(p_lat double precision,p_lon double precision,p_radius integer default 50000,p_category text default null,p_query text default '',p_limit integer default 100)
returns table(id uuid,name text,category text,latitude double precision,longitude double precision,description text,source_url text,source_id text,external_id text,observed_at timestamptz,reviewed_at timestamptz,distance double precision)
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 or p_radius is null or p_radius not between 1 and 100000 or p_limit is null or p_limit not between 1 and 200 or p_query is null or length(p_query)>120 or (p_category is not null and p_category not in ('Venues','Transport','Health','Education','Public services','Infrastructure')) then raise exception 'Invalid geographic query' using errcode='22023'; end if;
 return query select p.id,p.name,p.category,p.latitude,p.longitude,p.description,p.source_url,p.source_id,p.external_id,p.observed_at,p.reviewed_at,extensions.st_distance(p.location,extensions.st_setsrid(extensions.st_makepoint(p_lon,p_lat),4326)::extensions.geography)/1000 from public.places p
 where (p_category is null or p.category=p_category) and (p_query='' or p.name ilike '%'||p_query||'%' or p.description ilike '%'||p_query||'%')
 and extensions.st_dwithin(p.location,extensions.st_setsrid(extensions.st_makepoint(p_lon,p_lat),4326)::extensions.geography,p_radius)
 order by p.location operator(extensions.<->) extensions.st_setsrid(extensions.st_makepoint(p_lon,p_lat),4326)::extensions.geography, p.id limit p_limit;
end $$;
create function public.places_in_bounds(p_south double precision,p_west double precision,p_north double precision,p_east double precision,p_limit integer default 100)
returns setof public.places language plpgsql stable security invoker set search_path='' as $$
begin
 if p_south is null or p_north is null or p_west is null or p_east is null or p_south not between -90 and 90 or p_north not between -90 and 90 or p_west not between -180 and 180 or p_east not between -180 and 180 or p_south>p_north or p_north-p_south>5 or (case when p_east>=p_west then p_east-p_west else 360-p_west+p_east end)>5 or p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid or oversized bounds' using errcode='22023'; end if;
 return query select p.* from public.places p where p.latitude between p_south and p_north and ((p_west<=p_east and p.longitude between p_west and p_east) or (p_west>p_east and (p.longitude>=p_west or p.longitude<=p_east))) order by p.id limit p_limit;
end $$;
create function public.region_summary(p_lat double precision,p_lon double precision,p_radius integer default 50000)
returns table(category text,total bigint) language sql stable security invoker set search_path='' as $$
 select n.category,count(*) from public.nearby_places(p_lat,p_lon,p_radius,null,'',200) n group by n.category
$$;
comment on function public.region_summary is 'Summary of the nearest 200 visible places, not a population or complete facility count.';
create function public.admin_import_runs() returns setof private.import_runs language sql stable security invoker set search_path='' as $$ select * from private.import_runs order by started_at desc limit 20 $$;
-- Take an advisory lock and log each bounded import before the network request.
create function public.start_import() returns uuid language plpgsql security invoker set search_path='' as $$
declare run_id uuid;
begin
 if not public.is_mzansi_admin() then raise insufficient_privilege; end if;
 perform pg_catalog.pg_advisory_xact_lock(741852);
 if exists(select 1 from private.import_runs where started_at>now()-interval '15 minutes') then raise exception 'Import cooldown: retry after 15 minutes'; end if;
 insert into private.import_runs(source_id,requested_by,status) values('osm-durban',auth.uid(),'running') returning id into run_id;
 return run_id;
end $$;
create function public.finish_import(p_run uuid,p_rows jsonb default '[]',p_error text default null) returns integer language plpgsql security invoker set search_path='' as $$
declare item jsonb; n integer:=0;
begin
 if not public.is_mzansi_admin() then raise insufficient_privilege; end if;
 perform 1 from private.import_runs where id=p_run and status='running' and requested_by=auth.uid() for update;
 if not found then raise exception 'No active import owned by caller'; end if;
 if jsonb_typeof(p_rows)!='array' or jsonb_array_length(p_rows)>200 then raise exception 'Import exceeds 200 records'; end if;
 if p_error is null then
 for item in select value from jsonb_array_elements(p_rows) loop
 if (item->>'latitude')::float8 not between -30.05 and -29.60 or (item->>'longitude')::float8 not between 30.80 and 31.20 then raise exception 'Outside Durban import area'; end if;
 insert into public.places(source_id,external_id,name,category,latitude,longitude,source_url,observed_at)
 values('osm-durban',item->>'external_id',item->>'name',item->>'category',(item->>'latitude')::float8,(item->>'longitude')::float8,item->>'source_url',now())
 on conflict(source_id,external_id) do update set name=excluded.name,category=excluded.category,latitude=excluded.latitude,longitude=excluded.longitude,observed_at=excluded.observed_at,published=false,reviewed_at=null;
 n:=n+1;
 end loop;
 end if;
 update private.import_runs set completed_at=now(),status=case when p_error is null then 'succeeded' else 'failed' end,row_count=n,error=left(p_error,1000) where id=p_run;
 return n;
end $$;
revoke execute on all functions in schema public from public;
grant execute on function public.nearby_places(double precision,double precision,integer,text,text,integer),public.places_in_bounds(double precision,double precision,double precision,double precision,integer),public.region_summary(double precision,double precision,integer) to anon,authenticated;
grant execute on function public.is_mzansi_admin(),public.admin_import_runs(),public.start_import(),public.finish_import(uuid,jsonb,text) to authenticated;
