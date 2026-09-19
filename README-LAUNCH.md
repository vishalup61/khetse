# KhetSe — Launch Build

This package consolidates the KhetSe customer, seller and admin marketplace flows.

## Editable launch settings
Edit `launch-config.js` for business contact, delivery, payment display and business identity. Real phone/WhatsApp/email are intentionally blank until supplied.

Default delivery assumption: ₹30 below ₹300; free delivery at/above ₹300; initial focus on Ghazipur and selected nearby serviceable areas.

## Production secrets
Never commit `backend/.env`. Set `MONGODB_URI`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_TOKEN`, and `PAYOUT_ENCRYPTION_KEY` in Render environment variables. Use strong unique values.

## Payments
COD is enabled. Online payment is deliberately disabled until real Razorpay production/test credentials and server-side verification are configured.

## Before advertising
1. Replace the blank contact fields.
2. Confirm every product's image, price, stock and description in MongoDB.
3. Confirm delivery serviceability for your intended promotion area.
4. Place a real end-to-end test order on the live site and verify it in Admin and Seller dashboards.
5. Verify cancellation, status sync, payout and review flows.
6. Confirm applicable Indian business/food labelling, tax, consumer and marketplace requirements for the actual products/business.
