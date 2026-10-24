import {
  adminClient,
  errorMessage,
  hmacHex,
  jsonResponse,
  requiredEnv,
  secureEqual,
} from "../_shared/payment.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature") || "";
    const expectedSignature = await hmacHex(requiredEnv("RAZORPAY_WEBHOOK_SECRET"), rawBody);
    if (!secureEqual(expectedSignature, signature)) {
      return jsonResponse({ error: "Invalid webhook signature" }, 400);
    }

    const event = JSON.parse(rawBody);
    if (event.event !== "payment.captured") return jsonResponse({ received: true });

    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id || !payment?.id || !payment.amount || !payment.currency) {
      return jsonResponse({ error: "Captured payment payload is incomplete" }, 400);
    }

    const admin = adminClient();
    const { data: booking, error: lookupError } = await admin
      .from("bookings")
      .select("id")
      .eq("payment_order_id", payment.order_id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!booking) return jsonResponse({ error: "Booking for payment order was not found" }, 404);

    const { error: confirmError } = await admin.rpc("confirm_razorpay_payment", {
      p_booking_id: booking.id,
      p_order_id: payment.order_id,
      p_payment_id: payment.id,
      p_amount_paise: payment.amount,
      p_currency: payment.currency,
    });
    if (confirmError) throw confirmError;
    return jsonResponse({ received: true });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 500);
  }
});
