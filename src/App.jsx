import React, { useEffect, useMemo, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabase.js";

const money = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value || 0);

const todayString = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
};

const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay checkout could not be loaded. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

async function functionErrorMessage(error) {
  if (error?.context instanceof Response) {
    const response = await error.context.json();
    return response.error || error.message;
  }
  return error?.message || "The payment request failed.";
}

export default function App() {
  const [rooms, setRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [roomError, setRoomError] = useState("");
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const [checkIn, setCheckIn] = useState(addDays(todayString(), 1));
  const [checkOut, setCheckOut] = useState(addDays(todayString(), 3));
  const [guests, setGuests] = useState(2);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [bookingMessage, setBookingMessage] = useState("");
  const [bookingBusy, setBookingBusy] = useState(false);
  const [myBookings, setMyBookings] = useState([]);
  const [cancellationBusyId, setCancellationBusyId] = useState("");
  const [showAccount, setShowAccount] = useState(false);

  const nights = useMemo(() => {
    if (!checkIn || !checkOut) return 0;
    return Math.max(0, Math.round((new Date(`${checkOut}T12:00:00`) - new Date(`${checkIn}T12:00:00`)) / 86400000));
  }, [checkIn, checkOut]);

  const activeRoom = rooms.find((room) => room.id === selectedRoom);
  const estimate = activeRoom ? Number(activeRoom.price_per_night) * nights : 0;

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoadingRooms(false);
      setRoomError("Add your Supabase URL and publishable key to .env, then restart the dev server.");
      return;
    }

    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    async function loadRooms() {
      setLoadingRooms(true);
      const { data, error } = await supabase
        .from("room_types")
        .select("id, name, description, max_guests, price_per_night, image_url, amenities")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (!alive) return;
      if (error) setRoomError(error.message);
      else {
        setRooms(data || []);
        if (data?.length) setSelectedRoom((current) => current || data[0].id);
      }
      setLoadingRooms(false);
    }
    loadRooms();

    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (activeRoom && guests > activeRoom.max_guests) setGuests(activeRoom.max_guests);
  }, [activeRoom, guests]);

  async function handleAuth(event) {
    event.preventDefault();
    setAuthMessage("");
    if (!supabase) return;
    const result = authMode === "signup"
      ? await supabase.auth.signUp({ email: authEmail, password: authPassword })
      : await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });

    if (result.error) setAuthMessage(result.error.message);
    else if (authMode === "signup" && !result.data.session) {
      setAuthMessage("Check your email to confirm your account, then sign in.");
    } else {
      setAuthMessage("You're signed in.");
      setShowAccount(false);
    }
  }

  async function loadBookings() {
    if (!supabase || !session) return;
    const { data, error } = await supabase
      .from("bookings")
      .select("id, check_in, check_out, guests, total_amount, status, created_at, room_types(name)")
      .order("created_at", { ascending: false });
    if (error) setAuthMessage(error.message);
    else setMyBookings(data || []);
  }

  async function cancelBooking(booking) {
    if (!supabase || cancellationBusyId) return;
    if (!window.confirm("Cancel this booking? This will release the room for these dates.")) return;

    setCancellationBusyId(booking.id);
    setAuthMessage("");
    try {
      const { error } = await supabase.rpc("cancel_booking", {
        p_booking_id: booking.id,
      });
      if (error) {
        setAuthMessage(error.message);
        return;
      }

      setMyBookings((current) =>
        current.map((item) =>
          item.id === booking.id ? { ...item, status: "cancelled" } : item
        )
      );
      setAuthMessage("Booking cancelled. The room is available again.");
      await loadBookings();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Unable to cancel this booking.");
    } finally {
      setCancellationBusyId("");
    }
  }

  async function handleBooking(event) {
    event.preventDefault();
    setBookingMessage("");

    if (!session) {
      setBookingMessage("Please sign in before booking.");
      setShowAccount(true);
      return;
    }
    if (!activeRoom) {
      setBookingMessage("Choose a room type before continuing.");
      return;
    }
    if (nights < 1) {
      setBookingMessage("Check-out must be at least one night after check-in.");
      return;
    }
    if (checkIn < todayString()) {
      setBookingMessage("Check-in cannot be in the past.");
      return;
    }
    if (guests < 1 || guests > activeRoom.max_guests) {
      setBookingMessage(`This room accommodates up to ${activeRoom.max_guests} guests.`);
      return;
    }

    setBookingBusy(true);
    try {
      const { data: order, error } = await supabase.functions.invoke("create-razorpay-order", {
        body: {
          roomTypeId: activeRoom.id,
          checkIn,
          checkOut,
          guests: Number(guests),
          guestName: guestName.trim(),
          guestPhone: guestPhone.trim() || null,
        },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (!order?.orderId || !order?.keyId) {
        throw new Error(order?.error || "The payment order could not be created.");
      }

      await loadRazorpayCheckout();
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: "The Aurelia",
        description: `${activeRoom.name} · ${nights} ${nights === 1 ? "night" : "nights"}`,
        prefill: { name: guestName.trim(), email: session.user.email || "" },
        notes: { booking_id: order.bookingId },
        theme: { color: "#263c32" },
        handler: async (payment) => {
          setBookingBusy(true);
          try {
            const { error: verifyError } = await supabase.functions.invoke("verify-razorpay-payment", {
              body: { bookingId: order.bookingId, ...payment },
            });
            if (verifyError) throw new Error(await functionErrorMessage(verifyError));
            setBookingMessage(`Payment successful. Your booking reference is ${order.bookingId}.`);
            await loadBookings();
          } catch (error) {
            setBookingMessage(error instanceof Error ? error.message : "Payment was received but could not be verified yet. Check My account shortly.");
          } finally {
            setBookingBusy(false);
          }
        },
        modal: {
          ondismiss: () => {
            setBookingMessage("Payment was not completed. Your room is held for up to 30 minutes.");
          },
        },
      });
      checkout.on("payment.failed", (response) => {
        setBookingMessage(response.error?.description || "Payment failed. Please try again.");
      });
      checkout.open();
    } catch (error) {
      setBookingMessage(error instanceof Error ? error.message : "Unable to start payment. Please try again.");
    } finally {
      setBookingBusy(false);
    }
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setMyBookings([]);
    setAuthMessage("Signed out.");
  }

  return (
    <div className="site-shell">
      <div className="announcement">A QUIETER KIND OF LUXURY <span>·</span> THOUGHTFULLY CONSIDERED STAYS</div>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="The Aurelia home">
          <span className="brand-mark">A</span>
          <span><strong>THE AURELIA</strong><small>HOTEL & RETREAT</small></span>
        </a>
        <nav>
          <a href="#rooms">Rooms & Suites</a>
          <a href="#experience">The Experience</a>
          <button className="text-button" onClick={() => setShowAccount((value) => !value)}>
            {session ? "My account" : "Sign in"}
          </button>
          <a className="nav-cta" href="#booking">Book your stay <span>↗</span></a>
        </nav>
      </header>

      {showAccount && (
        <section className="account-panel" aria-label="Account">
          <button className="close-panel" onClick={() => setShowAccount(false)} aria-label="Close">×</button>
          {session ? (
            <div>
              <p className="eyebrow">YOUR ACCOUNT</p>
              <p className="account-email">{session.user.email}</p>
              <div className="account-actions">
                <button className="button button-dark" onClick={loadBookings}>View my bookings</button>
                <button className="button button-light" onClick={signOut}>Sign out</button>
              </div>
              {myBookings.length > 0 && <div className="booking-list">{myBookings.map((booking) => (
                <div className="booking-row" key={booking.id}>
                  <strong>{booking.room_types?.name || "Room"}</strong>
                  <span>{booking.check_in} → {booking.check_out}</span>
                  <span>{money(booking.total_amount)} · {booking.status === "pending_payment" ? "Awaiting payment" : booking.status.replaceAll("_", " ")}</span>
                  {booking.status === "confirmed" && booking.check_in > todayString() && (
                    <button
                      className="cancellation-button"
                      type="button"
                      disabled={Boolean(cancellationBusyId)}
                      onClick={() => cancelBooking(booking)}
                    >
                      {cancellationBusyId === booking.id ? "Cancelling…" : "Cancel booking"}
                    </button>
                  )}
                </div>
              ))}</div>}
              {authMessage && <p className={`form-message ${authMessage.startsWith("Booking cancelled") ? "success-message" : ""}`} role="status">{authMessage}</p>}
            </div>
          ) : (
            <form onSubmit={handleAuth} className="auth-form">
              <p className="eyebrow">{authMode === "signin" ? "WELCOME BACK" : "CREATE AN ACCOUNT"}</p>
              <h3>{authMode === "signin" ? "Sign in to continue" : "Join The Aurelia"}</h3>
              <label>Email address<input type="email" autoComplete="email" required value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} /></label>
              <label>Password<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength="8" required value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} /></label>
              <button className="button button-dark" type="submit">{authMode === "signin" ? "Sign in" : "Create account"}</button>
              <button className="inline-link" type="button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthMessage(""); }}>
                {authMode === "signin" ? "New here? Create an account" : "Already registered? Sign in"}
              </button>
              {authMessage && <p className="form-message">{authMessage}</p>}
            </form>
          )}
        </section>
      )}

      <main>
        <section className="hero" id="home">
          <div className="hero-image" role="img" aria-label="Luxury hotel with a pool surrounded by greenery" />
          <div className="hero-shade" />
          <div className="hero-content">
            <p className="eyebrow eyebrow-light">A PRIVATE WORLD OF YOUR OWN</p>
            <h1>Stay somewhere<br /><em>extraordinary.</em></h1>
            <p className="hero-copy">An intimate retreat for slower mornings, thoughtful details, and moments that stay with you.</p>
            <a className="button button-cream" href="#rooms">Discover the rooms <span>↘</span></a>
          </div>
          <div className="hero-caption"><span>01 / THE AURELIA</span><span>DESIGNED FOR YOUR WAY OF UNWINDING</span></div>
        </section>

        <section className="intro section-wrap" id="experience">
          <p className="eyebrow">THE ART OF STAYING WELL</p>
          <h2>Luxury is not more.<br /><em>It is more meaningful.</em></h2>
          <p>From considered spaces to warm, personal service, every detail is designed to make room for what matters.</p>
          <div className="intro-rule"><span>✳</span></div>
        </section>

        <section className="rooms-section section-wrap" id="rooms">
          <div className="section-heading">
            <div><p className="eyebrow">YOUR SANCTUARY</p><h2>Rooms & <em>Suites</em></h2></div>
            <p>Space to settle in. Details to discover.<br />A stay that feels entirely your own.</p>
          </div>
          {loadingRooms ? <p className="notice">Preparing your rooms…</p> : roomError ? <p className="notice notice-error">{roomError}</p> : rooms.length === 0 ? (
            <p className="notice">No rooms are listed yet. Add active room types in Supabase to display them here.</p>
          ) : (
            <div className="room-grid">
              {rooms.map((room, index) => (
                <article className={`room-card ${selectedRoom === room.id ? "room-card-selected" : ""}`} key={room.id}>
                  <div className="room-photo" style={{ backgroundImage: `url("${room.image_url || defaultRoomImages[index % defaultRoomImages.length]}")` }}>
                    <span className="room-number">0{index + 1}</span>
                    <button className="select-room" onClick={() => { setSelectedRoom(room.id); document.querySelector("#booking")?.scrollIntoView({ behavior: "smooth" }); }}>
                      {selectedRoom === room.id ? "Selected ✓" : "Choose room ↗"}
                    </button>
                  </div>
                  <div className="room-info">
                    <div className="room-title-row"><h3>{room.name}</h3><span>{money(room.price_per_night)} <small>/ night</small></span></div>
                    <p>{room.description || "A restful, beautifully considered room for your next escape."}</p>
                    <div className="room-meta"><span>♧ Up to {room.max_guests} guests</span><span>{(room.amenities || []).slice(0, 2).join(" · ") || "Thoughtful comforts"}</span></div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="booking-section" id="booking">
          <div className="booking-backdrop" />
          <div className="booking-layout section-wrap">
            <div className="booking-copy">
              <p className="eyebrow eyebrow-light">YOUR STAY, YOUR WAY</p>
              <h2>Make room for<br /><em>something lovely.</em></h2>
              <p>Choose your dates and let us take care of the details.</p>
              <div className="booking-note"><span>✳</span><p>Best available rates<br /><small>Room availability is checked securely when you book.</small></p></div>
            </div>
            <form className="booking-form" onSubmit={handleBooking}>
              <p className="eyebrow">PLAN YOUR STAY</p>
              <label>Room type
                <select value={selectedRoom} onChange={(e) => setSelectedRoom(e.target.value)} required>
                  {rooms.length === 0 && <option value="">No rooms available</option>}
                  {rooms.map((room) => <option key={room.id} value={room.id}>{room.name} — {money(room.price_per_night)}/night</option>)}
                </select>
              </label>
              <div className="form-grid">
                <label>Check-in<input type="date" min={todayString()} value={checkIn} onChange={(e) => { setCheckIn(e.target.value); if (checkOut <= e.target.value) setCheckOut(addDays(e.target.value, 1)); }} required /></label>
                <label>Check-out<input type="date" min={addDays(checkIn, 1)} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required /></label>
              </div>
              <div className="form-grid">
                <label>Guests<select value={guests} onChange={(e) => setGuests(Number(e.target.value))}>{Array.from({ length: Math.max(1, activeRoom?.max_guests || 2) }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? "guest" : "guests"}</option>)}</select></label>
                <label>Your name<input value={guestName} onChange={(e) => setGuestName(e.target.value)} autoComplete="name" required maxLength="120" placeholder="Full name" /></label>
              </div>
              <label>Phone (optional)<input type="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} autoComplete="tel" maxLength="30" placeholder="+91 ..." /></label>
              <div className="estimate"><span>{activeRoom?.name || "Select a room"} · {nights} {nights === 1 ? "night" : "nights"}</span><strong>{money(estimate)}</strong><small>Estimate only. Final amount is recalculated by the database. Taxes/fees are not included in this starter.</small></div>
              <button className="button button-dark booking-submit" type="submit" disabled={bookingBusy || loadingRooms || rooms.length === 0}>
                {bookingBusy ? "Starting secure checkout…" : "Continue to secure payment"} <span>↗</span>
              </button>
              <p className="small-note">{session ? "Razorpay test mode. Your room is held for up to 30 minutes while payment is pending." : "You'll need to sign in before continuing to payment."}</p>
              {bookingMessage && <p className={`form-message ${bookingMessage.startsWith("Payment successful") ? "success-message" : ""}`} role="status">{bookingMessage}</p>}
            </form>
          </div>
        </section>

        <section className="closing section-wrap">
          <p className="eyebrow">WE LOOK FORWARD TO WELCOMING YOU</p>
          <h2>Some places stay<br /><em>with you.</em></h2>
          <a className="button button-dark" href="#booking">Plan your stay <span>↗</span></a>
        </section>
      </main>

      <footer className="footer">
        <a className="brand brand-footer" href="#home"><span className="brand-mark">A</span><span><strong>THE AURELIA</strong><small>HOTEL & RETREAT</small></span></a>
        <span>Thoughtfully considered stays.</span>
        <span>© {new Date().getFullYear()} The Aurelia. Demo starter — replace with your real property details.</span>
      </footer>
    </div>
  );
}

const defaultRoomImages = [
  "https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&w=1200&q=85",
  "https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=85",
  "https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=85"
];
