# The Aurelia — single-hotel booking starter

A beginner-friendly React + Vite + CSS + Supabase starter for a single luxury hotel. It includes email/password sign-in, booking cancellation and a Razorpay test-mode payment flow. “The Aurelia” is placeholder branding; replace it with your property's actual name, rates, photos, room types, policies and contact details.

## Before you begin

Install the current Node.js LTS version from https://nodejs.org/. You need a Supabase account/project and a Razorpay account to test checkout. Payments must be tested with Razorpay test keys before any live launch. Do not use this starter for real customers until you have reviewed cancellation and refund rules, taxes, local time zone, operational workflow, monitoring and legal/privacy requirements.

## 1. Open and run the website

Open this folder in VS Code. In Terminal → New Terminal, run:

```bash
npm install
```

Copy `.env.example` to `.env`. In VS Code, right-click `.env.example` → Copy, paste it in the same root folder and rename the copy `.env` (Windows may hide file extensions). Fill in values from your Supabase project:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Use the project URL and **publishable** key from Supabase → Connect or Project Settings → API Keys. Never use a `service_role` or secret key in a browser app. Save `.env`, then run:

```bash
npm run dev
```

Open the local URL Vite prints, usually `http://localhost:5173`.

## 2. Create the database

1. In Supabase Dashboard, open the correct project.
2. Go to SQL Editor → New query.
3. Open `supabase/schema.sql` from this project, copy all of it into SQL Editor and inspect it.
4. Run the script. It creates `room_types`, `room_inventory`, `bookings`, RLS policies and the `create_booking` RPC, then seeds demo room types and 365 days of demo inventory.
5. In SQL Editor, run `supabase/cancel_booking.sql` to add the cancellation RPC. This step is required for existing and new projects.
6. In SQL Editor, run `supabase/payment_schema.sql` to add payment statuses, secure payment RPCs, and temporary inventory holds. Do not skip this step: it disables direct unpaid booking creation.
7. Check Table Editor to confirm the three tables and sample room types exist.
8. In Authentication → Providers, ensure Email is enabled. For local testing, sign up with an email you can verify. Supabase may require email confirmation before a session is created.

The script is intended for a fresh starter project. It uses `create table if not exists` and replaces the `create_booking` function, but you should not run it blindly on a production database or database with important data. Back up and review any existing schema first.

## 3. How booking works

- A guest signs in using Supabase Auth.
- The frontend calls the `create-razorpay-order` Edge Function; the database checks the authenticated user, dates, room type, guest limit and inventory.
- It calculates the total from the database's room rate, not the browser's estimate.
- It atomically decrements inventory and creates a pending-payment booking. A 30-minute hold prevents concurrent guests from reserving the same inventory.
- The server creates the Razorpay order. After checkout, the server verifies the signature and payment with Razorpay, captures authorized payments, and confirms the booking.
- A signed `payment.captured` webhook provides a second confirmation path if the guest closes the checkout page before returning.
- Guests can cancel their own confirmed bookings before the check-in day from their account. The database validates ownership and timing, then marks the booking cancelled and restores its inventory atomically.
- Cancelling a booking does not issue a refund.
- Expired payment holds are marked `expired` and their inventory is restored by the scheduled database job.
- RLS restricts customers to viewing their own bookings. Inventory is not readable by anonymous browser clients.

### Razorpay test checkout

1. Create or open a Razorpay account and enable **Test Mode**. Generate a test Key ID and Key Secret. Do not use live credentials for testing.
2. In the Supabase Dashboard, enable the `pg_cron` extension from Database → Extensions, then schedule expired payment holds to be released:

   ```sql
   select cron.schedule(
     'expire-pending-payment-bookings',
     '* * * * *',
     $$select public.expire_pending_payment_bookings();$$
   );
   ```

   The function also releases expired holds before each new booking attempt. The scheduled job releases them promptly even if no new booking is made.
3. Install and authenticate the Supabase CLI for your project, then set the Razorpay credentials as **Supabase Edge Function secrets**, never in `.env`, `VITE_*` variables, frontend code, or Git:

   ```bash
   supabase secrets set RAZORPAY_KEY_ID=rzp_test_YOUR_KEY_ID RAZORPAY_KEY_SECRET=YOUR_TEST_KEY_SECRET RAZORPAY_WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET
   ```

   Supabase Edge Functions provide `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the function runtime. Never expose the service-role key.
4. Deploy the payment Edge Functions from the project root:

   ```bash
   supabase functions deploy create-razorpay-order
   supabase functions deploy verify-razorpay-payment
   supabase functions deploy razorpay-webhook
   ```

5. In the Razorpay dashboard, add a webhook pointing to `https://YOUR_PROJECT_REF.supabase.co/functions/v1/razorpay-webhook`, use the exact webhook secret you stored above, and subscribe to the `payment.captured` event.
6. Sign in to the website, create a test booking and finish checkout using a Razorpay test payment method. A booking is confirmed only after the payment is captured and validated by the server. The database reserves inventory for up to 30 minutes while payment is pending and releases it if payment is not completed.

The browser only receives the Razorpay Key ID. Order creation, signature verification, amount/currency checks, capture and booking confirmation run in Supabase Edge Functions. Never accept card details directly in this form.

## 4. Customize the site

- Brand, headings and sections: `src/App.jsx`
- Colors, layout and responsive design: `src/styles.css`
- Supabase connection: `src/lib/supabase.js`
- Database schema, booking function, sample rates and inventory: `supabase/schema.sql`
- Add real hotel photos using image URLs you own or are licensed to use.
- Replace all demo room names, guest capacity, prices, amenities, taxes, cancellation terms, and contact information.
- The current demo inventory assumes five sellable rooms per room category every night. Set this to your real sellable inventory before testing meaningful bookings.

## 5. Test checklist

- [ ] With `.env` missing, the app shows a helpful setup message.
- [ ] Room types load from Supabase.
- [ ] A new user can sign up and sign in.
- [ ] A signed-out user cannot create a booking.
- [ ] A signed-in user can book an available room/date.
- [ ] Razorpay test checkout confirms a booking only after the payment is captured.
- [ ] A failed or abandoned payment does not create a confirmed booking, and its inventory hold expires.
- [ ] Invalid signatures, mismatched amounts and payments for another order cannot confirm a booking.
- [ ] The `payment.captured` webhook confirms a booking if the guest does not return to the site.
- [ ] A guest can cancel their own upcoming booking before check-in, and the room inventory is restored.
- [ ] A guest cannot cancel another user's booking, a previously cancelled booking, or a booking on/after its check-in day.
- [ ] Two users competing for the final room cannot both take it.
- [ ] A sold-out night returns an availability error and does not partially reserve earlier nights.
- [ ] A user can only view their own bookings.
- [ ] Invalid dates and guest counts are rejected by the database.
- [ ] Confirmed booking emails and refund behavior are not assumed to exist; add these deliberately.

## 6. Build and deploy

Verify the production build locally:

```bash
npm run build
npm run preview
```

Deploy the project to a static host such as Vercel or Netlify by importing your Git repository, setting the build command to `npm run build`, and the output directory to `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the host's environment-variable settings, then redeploy. The values are public browser configuration; database security depends on RLS and safe database functions, not secrecy of the publishable key.

Configure the production site's URL in Supabase Authentication → URL Configuration, including the Site URL and allowed redirect URLs for your deployed domain.

## Important launch gaps

This is a starter, not a complete hotel operations platform. The Razorpay integration is configured for test mode until you intentionally provision live credentials and complete merchant onboarding. It does not include automatic refunds, automated confirmation emails, an admin dashboard, staff permissions, tax calculation, promo codes, rate plans, maintenance blocks, time-zone policy, privacy/legal pages, analytics or backups/monitoring. Review the schema, payment settings, cancellation policy and operational process before accepting real payments.
