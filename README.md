# The Aurelia — single-hotel booking starter

A beginner-friendly React + Vite + CSS + Supabase starter for a single luxury hotel. “The Aurelia” is placeholder branding; replace it with your property's actual name, rates, photos, room types, policies and contact details.

## Before you begin

Install the current Node.js LTS version from https://nodejs.org/. You need a Supabase account/project. This starter supports email/password sign-in and booking creation. **Payments are intentionally not included.** The demo database confirms a booking and reduces inventory; do not use it for real customers until you have reviewed cancellation rules, taxes, local time zone, operational workflow, monitoring and legal/privacy requirements.

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
6. Check Table Editor to confirm the three tables and sample room types exist.
7. In Authentication → Providers, ensure Email is enabled. For local testing, sign up with an email you can verify. Supabase may require email confirmation before a session is created.

The script is intended for a fresh starter project. It uses `create table if not exists` and replaces the `create_booking` function, but you should not run it blindly on a production database or database with important data. Back up and review any existing schema first.

## 3. How booking works

- A guest signs in using Supabase Auth.
- The frontend calls `supabase.rpc('create_booking', ...)`.
- The database checks the authenticated user, dates, room type, guest limit and inventory.
- It calculates the total from the database's room rate, not the browser's estimate.
- It atomically decrements inventory for every night and inserts the booking in one transaction. If a night has no inventory, the transaction rolls back.
- Guests can cancel their own confirmed bookings before the check-in day from their account. The database validates ownership and timing, then marks the booking cancelled and restores its inventory atomically.
- Payments and refunds are not integrated; cancelling a booking does not issue a refund.
- RLS restricts customers to viewing their own bookings. Inventory is not readable by anonymous browser clients.

The sample sets booking status to `confirmed` because payment is not integrated yet. Before public launch, consider changing this to a hold/pending workflow with expiry and a secure payment webhook that confirms after payment. Never accept card details directly in this form.

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

This is a starter, not a complete hotel operations platform. It does not yet include payment, automated confirmation emails, cancellation/refund flows, admin dashboard, staff permissions, tax calculation, promo codes, rate plans, maintenance blocks, time-zone policy, privacy/legal pages, analytics or backups/monitoring. Have the schema and business rules reviewed before accepting real bookings.
