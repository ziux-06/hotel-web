import {
  adminClient,
  authenticatedUser,
  errorMessage,
  jsonResponse,
  razorpayAuthorization,
} from "../_shared/payment.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return jsonResponse({});
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let bookingId: string | undefined;
  let admin: ReturnType<typeof adminClient> | undefined;
  try {
    const user = await authenticatedUser(request);
    const body = await request.json();
    const razorpay = razorpayAuthorization();
    admin = adminClient();
    const { data: booking, error: bookingError } = await admin.rpc("create_payment_booking", {
      p_user_id: user.id,
      p_room_type_id: body.roomTypeId,
      p_check_in: body.checkIn,
      p_check_out: body.checkOut,
      p_guests: body.guests,
      p_guest_name: body.guestName,
      p_guest_phone: body.guestPhone || null,
    });
    if (bookingError) throw bookingError;
    bookingId = booking.booking_id;

    const expiry = Math.floor(new Date(booking.expires_at).getTime() / 1000);
    const orderResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: razorpay.header, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(booking.amount_paise),
        currency: booking.currency,
        receipt: bookingId,
        notes: { booking_id: bookingId },
        expire_by: expiry,
      }),
    });
    const order = await orderResponse.json();
    if (!orderResponse.ok) {
      throw new Error(order.error?.description || "Razorpay could not create a payment order");
    }

    const { error: saveOrderError } = await admin.rpc("set_payment_order", {
      p_booking_id: bookingId,
      p_order_id: order.id,
    });
    if (saveOrderError) {
      throw saveOrderError;
    }

    return jsonResponse({
      bookingId,
      orderId: order.id,
      amount: Number(booking.amount_paise),
      currency: booking.currency,
      keyId: razorpay.keyId,
    });
  } catch (error) {
    if (bookingId && admin) {
      const { error: releaseError } = await admin.rpc("fail_payment_booking", {
        p_booking_id: bookingId,
      });
      if (releaseError) {
        console.error("Could not release failed payment hold:", releaseError.message);
      }
    }
    return jsonResponse({ error: errorMessage(error) }, 400);
  }
});
