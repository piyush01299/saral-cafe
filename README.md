# Swaadly — Complete Website Project

A responsive food-ordering website starter with an embedded frontend and Node.js backend.

## Included features

- Six sample restaurants and menu items
- Restaurant and dish search
- Shopping cart and server-side price calculation
- Coupon codes: `WELCOME50` and `FOOD10`
- Tax and delivery-fee calculation
- Email/password signup and login
- User order history
- Order cancellation while the order is still `Placed`
- Admin dashboard APIs for restaurant, dish, coupon and order management
- Admin sales summary
- Order status and ETA updates
- Upstash Redis REST storage, with local JSON-file fallback
- Responsive frontend served directly by `server.js`

## Requirements

- Node.js 18 or newer
- No npm dependencies are required

## Run locally

1. Extract the ZIP.
2. Open a terminal in the extracted `swaadly-complete-project` folder.
3. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD`.
4. Start the server:

   ```bash
   npm start
   ```

   Or run `node server.js`.

5. Open `http://localhost:3000` in your browser.

## Admin login

- Email: `admin@swaadly.com`
- Password: the value you set in `ADMIN_PASSWORD`

Do not deploy with a weak or shared password. Keep `.env` private and never upload real secrets to GitHub.

## Upstash Redis setup

Create a Redis database in Upstash and copy its REST URL and REST token into your hosting provider's environment-variable settings:

- `UPSTASH_REDIS_REST_URL` = your Upstash REST URL
- `UPSTASH_REDIS_REST_TOKEN` = your Upstash REST token

If both are not configured, the app uses `data/db.json` on the local filesystem. Some hosting platforms have ephemeral filesystems, so configure Upstash for persistent production data.

## Important payment limitation

**Razorpay is not integrated in this project yet.** The current non-COD payment selection is explicitly marked as `Gateway integration pending`; it does not collect or verify real payments. Do not treat UPI/card form input as a real payment. Before accepting online payments, implement server-side Razorpay order creation, payment-signature verification, and webhook verification using secret keys stored only in server environment variables.

## Important feature scope

This ZIP packages the combined project currently available in this conversation. It includes restaurant browsing, cart, login, coupons, order history/cancellation, and admin order/menu management. It does **not** currently include Google sign-in, customer reviews, favourites, a dedicated live-map tracker, or automatic timed order-stage changes. Order status and ETA can be changed through the admin API/dashboard.

## API overview

- `GET /api/health`
- `GET /api/restaurants`
- `GET /api/coupons`
- `POST /api/signup`
- `POST /api/login`
- `GET /api/me` (authenticated)
- `POST /api/cart/quote` (authenticated)
- `POST /api/orders` (authenticated)
- `GET /api/orders` (authenticated)
- `POST /api/orders/:id/cancel` (authenticated)
- `GET /api/admin/orders` (admin)
- `GET /api/admin/summary` (admin)
- `POST /api/admin/restaurants` (admin)
- `POST /api/admin/dishes` (admin)
- `POST /api/admin/coupons` (admin)
- `POST /api/admin/orders/:id/status` (admin)

## Deploying

Deploy the folder to a Node.js host that supports Node 18+. Set `PORT`, `ADMIN_PASSWORD`, and the Upstash environment variables in the host's environment settings. Do not commit `.env` or real API credentials.

This is a starter project. Test signup, ordering, admin status updates, backups and persistence in a private test deployment before sharing it with customers.
