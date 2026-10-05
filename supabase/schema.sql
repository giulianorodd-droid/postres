-- =====================================================================
--  MAPA DE VENTAS — Esquema de base de datos para Supabase (gratis)
--  Cómo usarlo: Supabase > SQL Editor > New query > pegar TODO > Run
--  Se puede volver a ejecutar sin perder datos.
-- =====================================================================

-- >>>>>>>>>>  PIN INICIAL DEL ADMINISTRADOR (cambialo antes de ejecutar)  <<<<<<<<<<
-- Después también se puede cambiar desde el panel de administrador.
create or replace function _pin_admin_inicial() returns text language sql immutable as $$
  select '246810'::text
$$;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists settings (
  id              int primary key default 1 check (id = 1),
  admin_pin_hash  text not null,
  blacklist       text[] not null default array[
    'grido','freddo','luccianos','rapanui','chungo','persicco','cremolatti',
    'jauja','volta','situ','helados lucciano','havanna','starbucks',
    'cafe martinez','bonafide','mcdonalds','burger king','mostaza','subway','kfc',
    'carrefour','coto','jumbo','disco','vea','changomas'
  ],
  tz              text not null default 'America/Argentina/Buenos_Aires'
);

create table if not exists groups (
  id          bigserial primary key,
  name        text not null,
  color       text not null,
  ot_user     text unique,
  pin         text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists sessions (
  token       text primary key,
  group_id    bigint references groups(id) on delete cascade,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists login_failures (
  id  bigserial primary key,
  at  timestamptz not null default now()
);

-- Puntos GPS crudos (se compactan a "tracks" una vez terminado el día)
create table if not exists points (
  id          bigserial primary key,
  group_id    bigint not null references groups(id),
  device      text not null default '',
  ts          timestamptz not null,
  lat         double precision not null,
  lon         double precision not null,
  acc         real,
  received_at timestamptz not null default now(),
  unique (group_id, device, ts)
);
create index if not exists points_group_ts on points (group_id, ts);

-- Rastros compactados: se guardan PARA SIEMPRE (nunca se borran)
create table if not exists tracks (
  id          bigserial primary key,
  group_id    bigint not null references groups(id),
  day         date not null,
  lines       jsonb not null default '[]'::jsonb,   -- [[ [lon,lat], ... ], ...]
  matched     boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (group_id, day)
);

create table if not exists places (
  id             bigserial primary key,
  osm_id         text unique,
  name           text not null default '',
  category       text,
  address        text,
  lat            double precision not null,
  lon            double precision not null,
  status         text not null default 'pendiente'
                 check (status in ('pendiente','cliente','no_interesa','cerrado','inexistente')),
  note           text,
  status_at      timestamptz,
  status_group   bigint references groups(id),
  created_group  bigint references groups(id),
  created_at     timestamptz not null default now()
);

create table if not exists place_events (
  id        bigserial primary key,
  place_id  bigint not null references places(id) on delete cascade,
  group_id  bigint references groups(id),
  status    text not null,
  note      text,
  at        timestamptz not null default now()
);
create index if not exists place_events_place on place_events (place_id, at);

insert into settings (id, admin_pin_hash)
values (1, extensions.crypt(_pin_admin_inicial(), extensions.gen_salt('bf')))
on conflict (id) do nothing;

-- Seguridad: nadie accede a las tablas directamente; todo pasa por funciones.
alter table settings       enable row level security;
alter table groups         enable row level security;
alter table sessions       enable row level security;
alter table login_failures enable row level security;
alter table points         enable row level security;
alter table tracks         enable row level security;
alter table places         enable row level security;
alter table place_events   enable row level security;

-- ---------------------------------------------------------------------
-- Funciones internas
-- ---------------------------------------------------------------------
create or replace function _session(p_token text, out o_group bigint, out o_admin boolean)
language plpgsql security definer set search_path = public, extensions as $$
begin
  select s.group_id, s.is_admin into o_group, o_admin from sessions s where s.token = p_token;
  if not found then
    raise exception 'SESION_INVALIDA';
  end if;
  if o_group is not null and not exists (select 1 from groups g where g.id = o_group and g.active) then
    raise exception 'GRUPO_INACTIVO';
  end if;
  update sessions set last_seen = now()
   where token = p_token and last_seen < now() - interval '1 hour';
end $$;

create or replace function _require_admin(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s record;
begin
  select * into s from _session(p_token);
  if not s.o_admin then raise exception 'SOLO_ADMIN'; end if;
end $$;

create or replace function _tz() returns text language sql stable security definer
set search_path = public as $$ select tz from settings where id = 1 $$;

create or replace function _group_json(g groups, p_admin boolean) returns json
language sql stable as $$
  select case when p_admin then
    json_build_object('id', g.id, 'name', g.name, 'color', g.color, 'active', g.active,
                      'ot_user', g.ot_user, 'pin', g.pin)
  else
    json_build_object('id', g.id, 'name', g.name, 'color', g.color, 'active', g.active)
  end
$$;

create or replace function _place_json(p places) returns json language sql stable as $$
  select json_build_object('id', p.id, 'osm_id', p.osm_id, 'name', p.name, 'category', p.category,
    'address', p.address, 'lat', p.lat, 'lon', p.lon, 'status', p.status, 'note', p.note,
    'status_at', p.status_at, 'status_group', p.status_group, 'created_group', p.created_group)
$$;

-- ---------------------------------------------------------------------
-- Sesión
-- ---------------------------------------------------------------------
create or replace function login(p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_tok text; g groups;
begin
  if (select count(*) from login_failures where at > now() - interval '10 minutes') > 40 then
    raise exception 'DEMASIADOS_INTENTOS';
  end if;
  perform pg_sleep(0.3);
  v_tok := encode(gen_random_bytes(24), 'hex');

  if exists (select 1 from settings where id = 1 and admin_pin_hash = crypt(coalesce(p_pin,''), admin_pin_hash)) then
    insert into sessions (token, is_admin) values (v_tok, true);
    return json_build_object('token', v_tok, 'role', 'admin', 'group_id', null);
  end if;

  select * into g from groups where active and pin = p_pin limit 1;
  if found then
    insert into sessions (token, group_id) values (v_tok, g.id);
    return json_build_object('token', v_tok, 'role', 'group', 'group_id', g.id);
  end if;

  insert into login_failures default values;
  delete from login_failures where at < now() - interval '1 day';
  raise exception 'PIN_INCORRECTO';
end $$;

create or replace function logout(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from sessions where token = p_token
$$;

-- ---------------------------------------------------------------------
-- Lectura
-- ---------------------------------------------------------------------
create or replace function get_state(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_tz text := _tz();
begin
  select * into s from _session(p_token);
  return json_build_object(
    'me', json_build_object('role', case when s.o_admin then 'admin' else 'group' end, 'group_id', s.o_group),
    'groups', coalesce((select json_agg(_group_json(g, s.o_admin) order by g.id) from groups g), '[]'::json),
    'places', coalesce((select json_agg(_place_json(p)) from places p), '[]'::json),
    'blacklist', (select to_json(blacklist) from settings where id = 1),
    'tz', v_tz,
    'today', (now() at time zone v_tz)::date
  );
end $$;

create or replace function get_tracks(p_token text, p_from date, p_to date) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_tz text := _tz();
begin
  select * into s from _session(p_token);
  return json_build_object(
    'tracks', coalesce((
      select json_agg(json_build_object('group_id', t.group_id, 'day', t.day, 'lines', t.lines, 'matched', t.matched))
        from tracks t
       where (p_from is null or t.day >= p_from) and (p_to is null or t.day <= p_to)
    ), '[]'::json),
    'raw', coalesce((
      select json_agg(r) from (
        select p.group_id, (p.ts at time zone v_tz)::date as day,
               json_agg(json_build_array(round(p.lon::numeric, 6), round(p.lat::numeric, 6),
                        extract(epoch from p.ts)::bigint, p.acc, p.device) order by p.device, p.ts) as pts
          from points p
         where (p_from is null or p.ts >= (p_from::timestamp at time zone v_tz))
           and (p_to   is null or p.ts <  ((p_to + 1)::timestamp at time zone v_tz))
         group by p.group_id, (p.ts at time zone v_tz)::date
      ) r
    ), '[]'::json)
  );
end $$;

create or replace function place_history(p_token text, p_place bigint) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record;
begin
  select * into s from _session(p_token);
  return coalesce((
    select json_agg(json_build_object('status', e.status, 'note', e.note, 'at', e.at, 'group_id', e.group_id)
                    order by e.at desc)
      from place_events e where e.place_id = p_place
  ), '[]'::json);
end $$;

-- ---------------------------------------------------------------------
-- Locales
-- ---------------------------------------------------------------------
create or replace function set_place_status(p_token text, p_place bigint, p_status text, p_note text, p_at timestamptz)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_at timestamptz := least(coalesce(p_at, now()), now()); p places;
begin
  select * into s from _session(p_token);
  if p_status not in ('pendiente','cliente','no_interesa','cerrado','inexistente') then
    raise exception 'ESTADO_INVALIDO';
  end if;
  insert into place_events (place_id, group_id, status, note, at) values (p_place, s.o_group, p_status, p_note, v_at);
  update places set status = p_status,
                    note = coalesce(p_note, note),
                    status_at = v_at,
                    status_group = s.o_group
   where id = p_place and (status_at is null or status_at <= v_at);
  select * into p from places where id = p_place;
  if not found then raise exception 'LOCAL_NO_EXISTE'; end if;
  return _place_json(p);
end $$;

create or replace function set_place_note(p_token text, p_place bigint, p_note text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; p places;
begin
  select * into s from _session(p_token);
  update places set note = nullif(trim(p_note), '') where id = p_place returning * into p;
  if not found then raise exception 'LOCAL_NO_EXISTE'; end if;
  return _place_json(p);
end $$;

create or replace function add_place(p_token text, p_name text, p_category text, p_lat double precision,
                                     p_lon double precision, p_note text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; p places;
begin
  select * into s from _session(p_token);
  insert into places (name, category, lat, lon, note, created_group)
  values (coalesce(nullif(trim(p_name), ''), 'Local sin nombre'), p_category, p_lat, p_lon,
          nullif(trim(p_note), ''), s.o_group)
  returning * into p;
  return _place_json(p);
end $$;

-- p_places: [{osm_id, name, category, address, lat, lon}, ...]
create or replace function import_places(p_token text, p_places jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_new int;
begin
  select * into s from _session(p_token);
  with input as (
    select x->>'osm_id' as osm_id, coalesce(x->>'name', '') as name, x->>'category' as category,
           x->>'address' as address, (x->>'lat')::double precision as lat, (x->>'lon')::double precision as lon
      from (select distinct on (y->>'osm_id') y as x from jsonb_array_elements(p_places) y) d
     where x->>'osm_id' is not null
  ), ins as (
    insert into places (osm_id, name, category, address, lat, lon, created_group)
    select osm_id, name, category, address, lat, lon, s.o_group from input
    on conflict (osm_id) do update
      set name = excluded.name, category = excluded.category,
          address = coalesce(excluded.address, places.address)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_new from ins;
  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- Compactación de rastros (la hace la página web automáticamente)
-- ---------------------------------------------------------------------
create or replace function pending_compaction(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_tz text := _tz();
begin
  select * into s from _session(p_token);
  return coalesce((
    select json_agg(json_build_object('group_id', group_id, 'day', day, 'max_id', max_id, 'n', n))
      from (select group_id, (ts at time zone v_tz)::date as day, max(id) as max_id, count(*) as n
              from points
             where ts < ((now() at time zone v_tz)::date::timestamp at time zone v_tz)
             group by 1, 2 order by 2 limit 30) q
  ), '[]'::json);
end $$;

create or replace function get_raw(p_token text, p_group bigint, p_day date, p_max_id bigint) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_tz text := _tz();
begin
  select * into s from _session(p_token);
  return coalesce((
    select json_agg(json_build_array(lon, lat, extract(epoch from ts)::bigint, acc, device) order by device, ts)
      from points
     where group_id = p_group and id <= p_max_id
       and ts >= (p_day::timestamp at time zone v_tz) and ts < ((p_day + 1)::timestamp at time zone v_tz)
  ), '[]'::json);
end $$;

-- Guarda el rastro compactado y borra los puntos crudos ya procesados.
-- Es seguro aunque dos celulares compacten a la vez: sólo uno gana.
create or replace function save_track(p_token text, p_group bigint, p_day date, p_max_id bigint,
                                      p_lines jsonb, p_matched boolean) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v_tz text := _tz(); v_n int;
begin
  select * into s from _session(p_token);
  with del as (
    delete from points
     where group_id = p_group and id <= p_max_id
       and ts >= (p_day::timestamp at time zone v_tz) and ts < ((p_day + 1)::timestamp at time zone v_tz)
    returning 1
  ) select count(*) into v_n from del;
  if v_n = 0 then return false; end if;

  insert into tracks (group_id, day, lines, matched)
  values (p_group, p_day, coalesce(p_lines, '[]'::jsonb), p_matched)
  on conflict (group_id, day) do update
    set lines = tracks.lines || excluded.lines,
        matched = tracks.matched and excluded.matched,
        updated_at = now();
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Recepción de GPS desde OwnTracks (la llama la Edge Function)
-- ---------------------------------------------------------------------
create or replace function ingest_points(p_user text, p_pin text, p_device text, p_points jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare g groups; v_n int;
begin
  select * into g from groups where active and ot_user = p_user and pin = p_pin;
  if not found then raise exception 'CREDENCIALES_INVALIDAS'; end if;
  with ins as (
    insert into points (group_id, device, ts, lat, lon, acc)
    select g.id, left(coalesce(p_device, ''), 40), to_timestamp((x->>'tst')::bigint),
           (x->>'lat')::double precision, (x->>'lon')::double precision, (x->>'acc')::real
      from jsonb_array_elements(p_points) x
     where (x->>'acc') is null or (x->>'acc')::real <= 100
    on conflict do nothing
    returning 1
  ) select count(*) into v_n from ins;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Administración
-- ---------------------------------------------------------------------
create or replace function create_group(p_token text, p_name text, p_color text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare g groups; v_pin text; i int := 0;
begin
  perform _require_admin(p_token);
  loop
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from groups where pin = v_pin)
          and not exists (select 1 from settings where admin_pin_hash = crypt(v_pin, admin_pin_hash));
    i := i + 1; if i > 50 then raise exception 'NO_SE_PUDO_GENERAR_PIN'; end if;
  end loop;
  insert into groups (name, color, pin) values (trim(p_name), p_color, v_pin) returning * into g;
  update groups set ot_user = 'grupo' || g.id where id = g.id returning * into g;
  return _group_json(g, true);
end $$;

create or replace function update_group(p_token text, p_id bigint, p_name text, p_color text,
                                        p_active boolean, p_new_pin boolean) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare g groups; v_pin text; i int := 0;
begin
  perform _require_admin(p_token);
  update groups set name = coalesce(nullif(trim(p_name), ''), name),
                    color = coalesce(p_color, color),
                    active = coalesce(p_active, active)
   where id = p_id returning * into g;
  if not found then raise exception 'GRUPO_NO_EXISTE'; end if;
  if coalesce(p_new_pin, false) then
    loop
      v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
      exit when not exists (select 1 from groups where pin = v_pin)
            and not exists (select 1 from settings where admin_pin_hash = crypt(v_pin, admin_pin_hash));
      i := i + 1; if i > 50 then raise exception 'NO_SE_PUDO_GENERAR_PIN'; end if;
    end loop;
    update groups set pin = v_pin where id = p_id returning * into g;
    delete from sessions where group_id = p_id;
  end if;
  if not g.active then delete from sessions where group_id = p_id; end if;
  return _group_json(g, true);
end $$;

create or replace function set_blacklist(p_token text, p_list text[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_admin(p_token);
  update settings set blacklist = coalesce(p_list, '{}') where id = 1;
end $$;

create or replace function change_admin_pin(p_token text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_admin(p_token);
  if length(coalesce(p_new, '')) < 6 then raise exception 'PIN_CORTO'; end if;
  if not exists (select 1 from settings where id = 1 and admin_pin_hash = crypt(p_old, admin_pin_hash)) then
    raise exception 'PIN_INCORRECTO';
  end if;
  if exists (select 1 from groups where pin = p_new) then raise exception 'PIN_EN_USO'; end if;
  update settings set admin_pin_hash = crypt(p_new, gen_salt('bf')) where id = 1;
  delete from sessions where is_admin and token <> p_token;
end $$;

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  login(text), logout(text), get_state(text), get_tracks(text, date, date), place_history(text, bigint),
  set_place_status(text, bigint, text, text, timestamptz), set_place_note(text, bigint, text),
  add_place(text, text, text, double precision, double precision, text), import_places(text, jsonb),
  pending_compaction(text), get_raw(text, bigint, date, bigint),
  save_track(text, bigint, date, bigint, jsonb, boolean),
  ingest_points(text, text, text, jsonb),
  create_group(text, text, text), update_group(text, bigint, text, text, boolean, boolean),
  set_blacklist(text, text[]), change_admin_pin(text, text, text)
to anon, authenticated, service_role;

notify pgrst, 'reload schema';
