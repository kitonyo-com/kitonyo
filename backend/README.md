# PayNecta checkout

The existing EN/CZ static site keeps its design and adds a basket. Only KES (displayed as KSh) can be paid. CZK, USD and EUR remain estimates with payment disabled. Domain registration is a separate basket item starting at KSh 650 for the first year; domain protection and hosting still require a quote.

## Deployment

Deploy `kitonyo-checkout` to Cloudflare Workers, not GitHub Pages. Build: `node build-public.cjs`. Deploy: `npx wrangler@4 deploy --config wrangler.worker.jsonc`. The public asset allowlist excludes backend sources, secrets and repository metadata. Existing production remains on Cloudflare Pages until an explicit cutover.

1. The EU-jurisdiction D1 database `kitonyo-orders` is configured in `wrangler.worker.jsonc`. Apply `backend/schema.sql` once through the D1 console, or `npx wrangler@4 d1 execute kitonyo-orders --remote --file backend/schema.sql`.
2. Add `PAYNECTA_PUBLIC_KEY` and `PAYNECTA_SECRET_KEY` as encrypted Worker Secrets. Never place either key in HTML, source code, committed files, build variables or chat. The secret key must be entered by the owner in Cloudflare. The public key is also kept server-side.
3. Finish the PayNecta `kitonyo` TapFlow: open amount, approved payout method, usable collection status, completed business verification and sufficient fee credit. Do not rotate keys unless intended: generating a replacement pair revokes the old pair.
4. Add the actual preview origin to `ALLOWED_ORIGINS` for a controlled preview. For the current separate Pages frontend, set the `kitonyo-api` meta content on the six basket pages to the deployed Worker HTTPS origin. On the unified Worker site leave this value empty for same-origin API calls.
5. Keep `PAYMENTS_ENABLED=false` until keys, schema and TapFlow readiness are verified. To enable, set it to `true` in the deployed configuration. Subsequent Wrangler deployments take variables from `wrangler.worker.jsonc`; update it deliberately when enabling production.
6. Use server-side `GET /whoami` and `GET /tapflows?usable=true` to verify the business and TapFlow before enabling. Do not log keys, access tokens or full provider responses.
7. PayNecta currently has no sandbox. Unit tests use fixtures and do not send payment prompts or move money. A live acceptance payment must be performed by the owner. Never treat a test fixture as a real payment.

## Payment integrity

The Worker owns the catalog, recomputes totals, rejects unsupported currency, duplicate product lines and incompatible website packages. It records the terms revision and optional early-start request. Name/email/brief stay in D1; the provider receives a random reference and amount, no customer phone or email.

Each order uses an unpredictable UUID and a separate 256-bit bearer capability, stored hashed in D1. The browser stores its current capability in session storage, never in a query string. Checkout creation is idempotent for that order. A provider timeout is ambiguous: it leaves the order in `creating` and does not silently create a second checkout. Support must inspect the order before resetting it. Reloading the same tab can resume an existing persisted session.

Payment verification requires the provider session ID, merchant reference, KES currency, exact session/payment amounts and `payment.status=succeeded` to match the stored order. Neither `postMessage`, iframe cancellation nor a return-page visit marks an order paid or failed. The iframe listener validates both origin and frame window. Cron checks pending sessions once a minute after the browser closes; request polling is throttled in D1. Provider failures stay pending.

## Operations

Read orders through the authenticated Cloudflare D1 console. Only `state=paid` is fulfillment-ready. Match the saved `payment_reference` in PayNecta. `creating` means manual investigation is needed; `pending` means payment has not been verified. Pending sessions are reconciled automatically for seven days; older or ambiguous records require merchant reconciliation before any new payment request. Do not split orders to evade the provider's KES 250,000 transaction ceiling.

Kitonyo must email the customer the order confirmation and saved terms separately; this integration does not send email or generate invoices. Review the customer's brief and agreed scope before accepting/starting the project. Export the order details and applicable terms for that confirmation. No service work is started automatically.

The first release intentionally has no public order-list/admin endpoint and no automated refunds or fulfillment. Refunds and payout destination changes remain merchant actions. Apply the existing privacy retention policy to D1 records and any backups; do not keep unsuccessful checkout personal data indefinitely. Do not enable request-body logging. Rate-limit buckets are salted hashes and expire after two minutes.

Domain registration is a separate first-year item with a server-enforced minimum of KSh 650. A higher agreed whole-shilling amount is allowed; domain name, amount and quantity (one) are validated and saved with the order. Registration and renewals are performed manually after confirming availability and registrar cost.

Bot protection: set `TURNSTILE_REQUIRED=true`, publish `TURNSTILE_SITE_KEY`, and store `TURNSTILE_SECRET_KEY` as an encrypted runtime Secret. The Worker verifies each new order's proof with Cloudflare Siteverify and checks both hostname and the `checkout` action. Invalid, expired or replayed proofs cannot create a new session. Existing idempotent order retries do not consume another proof. Checkout creation is additionally limited to three attempts/minute and twelve/hour per hashed IP. Hourly rate buckets expire after one hour. These protections cover Kitonyo's checkout endpoint, not the public PayNecta TapFlow or OTP resend controls on PayNecta's domain. A provider-side SMS cap or OTP throttle must be configured/agreed with PayNecta separately.

## Validation

`node --test backend/worker.test.mjs` checks pricing, input validation, origin restrictions, capability authorization, timeout/retry safety, rate limiting, strict settlement verification and browser-independent reconciliation. `node build-public.cjs` builds public-only output. Inspect EN/CZ index/add pages and currency switching in a browser before rollout.

Official contracts: https://docs.paynecta.co.ke/api/checkout-sessions/ · https://docs.paynecta.co.ke/api/embedded-checkout/ · https://api.paynecta.co.ke/v1/openapi.yaml
