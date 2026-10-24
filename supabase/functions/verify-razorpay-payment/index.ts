import {
  adminClient,
  authenticatedUser,
  errorMessage,
  hmacHex,
  jsonResponse,
  razorpayAuthorization,
  secureEqual,
} from "../_shared/payment.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return jsonResponse({});
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    await authenticatedUser(request);
    const body = await request.json();
    const {
      bookingId,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = body;
    if (!bookingId || !orderId || !paymentId || !signature) {
      return jsonResponse({ error: "Payment verification details are incomplete" }, 400);
    }

    const { keySecret, header } = razorpayAuthorization();
    const expectedSignature = await hmacHex(keySecret, `${orderId}|${paymentId}`);
    if (!secureEqual(expectedSignature, signature)) {
      return jsonResponse({ error: "Razorpay payment signature is invalid" }, 400);
    }

    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: header } },
    );
    let payment = await paymentResponse.json();
    if (!paymentResponse.ok) {
      return jsonResponse({ error: "Could not verify the payment with Razorpay" }, 502);
    }
    if (payment.order_id !== orderId) {
      return jsonResponse({ error: "Payment does not match the Razorpay order" }, 400);
    }

    if (payment.status === "authorized") {
      const captureResponse = await fetch(
        `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/capture`,
        {
          method: "POST",
          headers: { Authorization: header, "Content-Type": "application/json" },
          body: JSON.stringify({ amount: payment.amount, currency: payment.currency }),
        },
      );
      payment = await captureResponse.json();
      if (!captureResponse.ok) {
        return jsonResponse({ error: payment.error?.description || "Razorpay could not capture this payment" }, 502);
      }
    }
    if (payment.status !== "captured") {
      return jsonResponse({ error: "Payment has not been captured. Please try again or contact the hotel." }, 400);
    }

    const admin = adminClient();
    const { error } = await admin.rpc("confirm_razorpay_payment", {
      p_booking_id: bookingId,
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_amount_paise: payment.amount,
      p_currency: payment.currency,
    });
    if (error) throw error;

    return jsonResponse({ bookingId, status: "confirmed" });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400);
  }
});
