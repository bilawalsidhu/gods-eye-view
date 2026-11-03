begin;
insert into auth.users(id) values('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
insert into public.profiles(display_name) values('Verification A');
insert into public.bookmarks(place_id) select id from public.places limit 1;
insert into public.saved_views(name,longitude,latitude,height,heading,pitch,roll) values('Verification',31,-29,1000,0,0,0);
do $$ begin
 if (select count(*) from public.bookmarks)<>1 then raise exception 'Owner bookmark missing'; end if;
 if public.is_mzansi_admin() then raise exception 'Unexpected admin access'; end if;
 begin perform public.start_import(); raise exception 'Import allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
 if exists(select 1 from public.profiles) or exists(select 1 from public.bookmarks) or exists(select 1 from public.saved_views) then raise exception 'Cross-user read leak'; end if;
 update public.saved_views set name='Hijack';
 if found then raise exception 'Cross-user write leak'; end if;
 begin insert into public.profiles(user_id) values('10000000-0000-4000-8000-000000000001'); raise exception 'Cross-user insert allowed'; exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
 if (select count(*) from public.nearby_places(-29.8587,31.0218))<>3 then raise exception 'Published query wrong';end if;
 if exists(select 1 from public.places_in_bounds(-29.9,31,-29.8,31.1) where not published) then raise exception 'Draft leak';end if;
 begin perform public.nearby_places(91,31);raise exception 'Invalid latitude accepted'; exception when invalid_parameter_value then null;end;
 begin perform public.nearby_places(-29,31,100001);raise exception 'Oversized radius accepted'; exception when invalid_parameter_value then null;end;
 begin perform public.places_in_bounds(-90,-180,90,180);raise exception 'Oversized bounds accepted'; exception when invalid_parameter_value then null;end;
 perform public.places_in_bounds(-1,179,1,-179);
end $$;
rollback;
select 'Owner CRUD, cross-user isolation, admin denial, published reads, invalid geography and antimeridian tests passed; fixtures rolled back' as verification;
