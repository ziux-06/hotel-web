-- THE AURELIA / single-hotel starter schema for Supabase.
-- Run in Supabase Dashboard > SQL Editor using the project's SQL editor.
-- Review this file before running it on any database with existing production data.

create extension if not exists pgcrypto;

-- One room type represents a sellable room category, not an individual physical room.
create table if not exists public.room_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  max_guests integer not null default 2 check (max_guests between 1 and 12),
  price_per_night numeric(12,2) not null check (price_per_night >= 0),
  image_url text,
  amenities text[] not null default '{}',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Inventory is tracked per room category and night. Create one row for every sellable night.
create table if not exists public.room_inventory (
  room_type_id uuid not null references public.room_types(id) on delete restrict,
  stay_date date not null,
  rooms_available integer not null default 0 check (rooms_available >= 0),
  primary key (room_type_id, stay_date)
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  room_type_id uuid not null references public.room_types(id) on delete restrict,
  check_in date not null,
  check_out date not null,
  guests integer not null check (guests between 1 and 12),
  guest_name text not null,
  guest_phone text,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  currency text not null default 'INR',
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint valid_stay_dates check (check_out > check_in)
);

create index if not exists bookings_user_created_idx
  on public.bookings (user_id, created_at desc);
create index if not exists bookings_dates_idx
  on public.bookings (check_in, check_out);

alter table public.room_types enable row level security;
alter table public.room_inventory enable row level security;
alter table public.bookings enable row level security;

-- Visitors can see active room categories only.
drop policy if exists "Anyone can read active room types" on public.room_types;
create policy "Anyone can read active room types"
  on public.room_types for select
  using (is_active = true);

-- Inventory is not exposed to the browser. The booking RPC reads/updates it as its owner.
-- Do not add a public select policy to room_inventory.

-- Customers can only read their own bookings. Booking creation is performed through RPC.
drop policy if exists "Customers read their own bookings" on public.bookings;
create policy "Customers read their own bookings"
  on public.bookings for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.room_types from anon, authenticated;
grant select on public.room_types to anon, authenticated;
revoke all on public.room_inventory from anon, authenticated;
revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;

-- A transaction-safe booking function. Inventory is decremented one night at a time;
-- if any night is unavailable, raising an exception rolls back all decrements and the booking.
create or replace function public.create_booking(
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date,
  p_guests integer,
  p_guest_name text,
  p_guest_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.room_types%rowtype;
  v_night date;
  v_total numeric(12,2);
  v_booking_id uuid;
  v_phone text;
begin
  if v_user_id is null then
    raise exception 'Sign in before booking';
  end if;

  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception 'Choose valid check-in and check-out dates';
  end if;

  if p_check_in < (now() at time zone 'UTC')::date then
    raise exception 'Check-in cannot be in the past';
  end if;

  if p_check_out - p_check_in > 30 then
    raise exception 'Bookings are limited to 30 nights';
  end if;

  if p_guests is null or p_guests < 1 then
    raise exception 'At least one guest is required';
  end if;

  if p_guest_name is null or length(trim(p_guest_name)) < 2 or length(trim(p_guest_name)) > 120 then
    raise exception 'Enter a valid guest name';
  end if;

  v_phone := nullif(left(trim(coalesce(p_guest_phone, '')), 30), '');

  select * into v_room
  from public.room_types
  where id = p_room_type_id and is_active = true;

  if not found then
    raise exception 'This room type is not available for booking';
  end if;

  if p_guests > v_room.max_guests then
    raise exception 'This room type cannot accommodate that many guests';
  end if;

  v_total := v_room.price_per_night * (p_check_out - p_check_in);

  -- Each conditional update locks the inventory row and succeeds only if stock remains.
  v_night := p_check_in;
  while v_night < p_check_out loop
    update public.room_inventory
       set rooms_available = rooms_available - 1
     where room_type_id = p_room_type_id
       and stay_date = v_night
       and rooms_available > 0;

    if not found then
      raise exception 'No availability for %; choose other dates or a different room', v_night;
    end if;

    v_night := v_night + 1;
  end loop;

  insert into public.bookings (
    user_id, room_type_id, check_in, check_out, guests,
    guest_name, guest_phone, total_amount, currency, status
  ) values (
    v_user_id, p_room_type_id, p_check_in, p_check_out, p_guests,
    trim(p_guest_name), v_phone, v_total, 'INR', 'confirmed'
  )
  returning id into v_booking_id;

  return jsonb_build_object(
    'booking_id', v_booking_id,
    'total_amount', v_total,
    'currency', 'INR',
    'status', 'confirmed'
  );
end;
$$;

revoke all on function public.create_booking(uuid, date, date, integer, text, text) from public, anon;
grant execute on function public.create_booking(uuid, date, date, integer, text, text) to authenticated;

-- DEMO SEED DATA. Change hotel name, descriptions, prices, images and inventory to your real property.
insert into public.room_types (name, description, max_guests, price_per_night, image_url, amenities, sort_order)
select seed.name, seed.description, seed.max_guests, seed.price_per_night, seed.image_url, seed.amenities, seed.sort_order
from (values
  ('Deluxe Garden Room', 'A calm, light-filled room with natural textures and thoughtful comforts.', 2, 8500.00,
   'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&w=1200&q=85',
   array['King bed','Garden view','Breakfast option'], 1),
  ('Premier Suite', 'A spacious suite with a separate lounge and room to unwind.', 3, 14500.00,
   'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=85',
   array['King bed','Lounge','Rain shower'], 2),
  ('Signature Residence', 'A private-feeling residence for a more indulgent escape.', 4, 22000.00,
   'https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=85',
   array['King bed','Living area','Premium amenities'], 3)
) as seed(name, description, max_guests, price_per_night, image_url, amenities, sort_order)
where not exists (select 1 from public.room_types existing where existing.name = seed.name);

-- Create a 365-day demo inventory calendar for each active room type.
-- Existing inventory rows are left unchanged so this can be re-run without resetting bookings.
insert into public.room_inventory (room_type_id, stay_date, rooms_available)
select rt.id, d.stay_date::date, 5
from public.room_types rt
cross join generate_series(current_date, current_date + 365, interval '1 day') as d(stay_date)
where rt.is_active = true
on conflict (room_type_id, stay_date) do nothing;

-- Ask PostgREST to refresh its schema cache.
notify pgrst, 'reload schema';
