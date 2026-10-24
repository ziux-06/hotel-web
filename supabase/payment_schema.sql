-- Payment workflow for the Razorpay test-mode integration.
-- Run after schema.sql and cancel_booking.sql in Supabase SQL Editor.
-- Inventory is held for 30 minutes while payment is pending.

alter table public.bookings
  alter column status set default 'pending_payment',
  add column if not exists payment_expires_at timestamptz,
  add column if not exists payment_order_id text,
  add column if not exists payment_id text;

alter table public.bookings
  drop constraint if exists bookings_status_check,
  add constraint bookings_status_check
    check (status in ('pending_payment', 'confirmed', 'cancelled', 'payment_failed', 'expired'));

create unique index if not exists bookings_payment_order_id_idx
  on public.bookings (payment_order_id)
  where payment_order_id is not null;
create unique index if not exists bookings_payment_id_idx
  on public.bookings (payment_id)
  where payment_id is not null;
create index if not exists bookings_pending_payment_expiry_idx
  on public.bookings (payment_expires_at)
  where status = 'pending_payment';

-- Browser clients must not create confirmed bookings without verified payment.
revoke all on function public.create_booking(uuid, date, date, integer, text, text)
  from public, anon, authenticated;

create or replace function public.expire_pending_payment_bookings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired record;
  v_night date;
  v_count integer := 0;
begin
  for v_expired in
    select id, room_type_id, check_in, check_out
      from public.bookings
     where status = 'pending_payment'
       and payment_expires_at <= now()
     order by payment_expires_at, id
     for update
  loop
    v_night := v_expired.check_in;
    while v_night < v_expired.check_out loop
      update public.room_inventory
         set rooms_available = rooms_available + 1
       where room_type_id = v_expired.room_type_id
         and stay_date = v_night;
      if not found then
        raise exception 'Inventory is missing for %; expired reservation cleanup failed', v_night;
      end if;
      v_night := v_night + 1;
    end loop;

    update public.bookings
       set status = 'expired'
     where id = v_expired.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.create_payment_booking(
  p_user_id uuid,
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
  v_room public.room_types%rowtype;
  v_booking public.bookings%rowtype;
  v_night date;
  v_total numeric(12,2);
  v_phone text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Payment bookings must be created by the payment service';
  end if;

  if p_user_id is null then
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

  perform public.expire_pending_payment_bookings();

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
  if v_total < 1 then
    raise exception 'The booking total must be at least INR 1 for Razorpay checkout';
  end if;

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

  v_phone := nullif(left(trim(coalesce(p_guest_phone, '')), 30), '');
  insert into public.bookings (
    user_id, room_type_id, check_in, check_out, guests, guest_name, guest_phone,
    total_amount, currency, status, payment_expires_at
  ) values (
    p_user_id, p_room_type_id, p_check_in, p_check_out, p_guests, trim(p_guest_name), v_phone,
    v_total, 'INR', 'pending_payment', now() + interval '30 minutes'
  )
  returning * into v_booking;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'total_amount', v_booking.total_amount,
    'amount_paise', (v_booking.total_amount * 100)::bigint,
    'currency', v_booking.currency,
    'expires_at', v_booking.payment_expires_at
  );
end;
$$;

create or replace function public.set_payment_order(
  p_booking_id uuid,
  p_order_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the payment service can update payment orders';
  end if;
  if p_order_id is null or p_order_id = '' then
    raise exception 'A payment order ID is required';
  end if;

  update public.bookings
     set payment_order_id = p_order_id
   where id = p_booking_id
     and status = 'pending_payment'
     and payment_expires_at > now();
  if not found then
    raise exception 'Booking is no longer awaiting payment';
  end if;
end;
$$;

create or replace function public.fail_payment_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_night date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the payment service can release payment holds';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id and status = 'pending_payment'
   for update;
  if not found then
    return;
  end if;

  v_night := v_booking.check_in;
  while v_night < v_booking.check_out loop
    update public.room_inventory
       set rooms_available = rooms_available + 1
     where room_type_id = v_booking.room_type_id
       and stay_date = v_night;
    if not found then
      raise exception 'Inventory is missing for %; payment hold was not released', v_night;
    end if;
    v_night := v_night + 1;
  end loop;

  update public.bookings set status = 'payment_failed' where id = v_booking.id;
end;
$$;

create or replace function public.confirm_razorpay_payment(
  p_booking_id uuid,
  p_order_id text,
  p_payment_id text,
  p_amount_paise bigint,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the payment service can confirm payments';
  end if;
  if p_booking_id is null or p_order_id is null or p_payment_id is null
     or p_amount_paise is null or p_currency is null then
    raise exception 'Payment confirmation details are incomplete';
  end if;

  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;
  if not found then
    raise exception 'Booking not found';
  end if;
  if v_booking.payment_order_id is distinct from p_order_id then
    raise exception 'Payment order does not match this booking';
  end if;
  if p_amount_paise is distinct from (v_booking.total_amount * 100)::bigint
     or upper(coalesce(p_currency, '')) <> v_booking.currency then
    raise exception 'Payment amount or currency does not match this booking';
  end if;

  if v_booking.status = 'confirmed' and v_booking.payment_id = p_payment_id then
    return;
  end if;
  if v_booking.status <> 'pending_payment' or v_booking.payment_expires_at <= now() then
    raise exception 'Booking is no longer awaiting payment';
  end if;

  update public.bookings
     set status = 'confirmed',
         payment_id = p_payment_id,
         payment_expires_at = null
   where id = v_booking.id;
end;
$$;

revoke all on function public.create_payment_booking(uuid, uuid, date, date, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.expire_pending_payment_bookings()
  from public, anon, authenticated;
revoke all on function public.set_payment_order(uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_payment_booking(uuid)
  from public, anon, authenticated;
revoke all on function public.confirm_razorpay_payment(uuid, text, text, bigint, text)
  from public, anon, authenticated;

grant execute on function public.create_payment_booking(uuid, uuid, date, date, integer, text, text)
  to service_role;
grant execute on function public.expire_pending_payment_bookings() to service_role;
grant execute on function public.set_payment_order(uuid, text) to service_role;
grant execute on function public.fail_payment_booking(uuid) to service_role;
grant execute on function public.confirm_razorpay_payment(uuid, text, text, bigint, text)
  to service_role;

notify pgrst, 'reload schema';
