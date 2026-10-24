-- Allow authenticated guests to cancel their own confirmed bookings before check-in.
-- Inventory restoration and cancellation are committed together in one transaction.
create or replace function public.cancel_booking(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings%rowtype;
  v_night date;
begin
  if v_user_id is null then
    raise exception 'Sign in before cancelling a booking';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Booking not found';
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception 'This booking is not active';
  end if;

  if v_booking.check_in <= (now() at time zone 'UTC')::date then
    raise exception 'Bookings can only be cancelled before the check-in day';
  end if;

  v_night := v_booking.check_in;
  while v_night < v_booking.check_out loop
    update public.room_inventory
       set rooms_available = rooms_available + 1
     where room_type_id = v_booking.room_type_id
       and stay_date = v_night;

    if not found then
      raise exception 'Inventory is missing for %; cancellation was not completed', v_night;
    end if;

    v_night := v_night + 1;
  end loop;

  update public.bookings
     set status = 'cancelled'
   where id = v_booking.id;

  return jsonb_build_object('booking_id', v_booking.id, 'status', 'cancelled');
end;
$$;

revoke all on function public.cancel_booking(uuid) from public, anon;
grant execute on function public.cancel_booking(uuid) to authenticated;
