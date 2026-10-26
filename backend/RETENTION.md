# Order retention and erasure

Policy revision: 26 October 2026. Times in D1 are UTC epoch milliseconds.

This is a purpose-based retention policy, not a claim that GDPR prescribes a fixed failed-checkout period. The 30-day and 1,095-day periods below are Kitonyo's operational choices. They do not override an actual contract, accounting/tax duty, receivable, complaint, legal claim or preservation requirement. Only the necessary records may be kept for each purpose.

## Rules

| Record | Action and clock |
| --- | --- |
| Paid order, or any row with `paid_at` or `payment_reference` | Never enter automatic failed-order cleanup. Keep necessary contract records during performance and normally three calendar years after the documented contract end, with a longer justified hold for disputes. Payment time is not contract completion. |
| `pending`, `creating`, provider error, timeout, unknown/mismatched response, missing provider session | Do not infer non-payment from age. Refer to merchant reconciliation after seven days and review at least monthly until resolved. Do not recreate an ambiguous checkout. |
| Provider-confirmed expired checkout with no payment | Persist closure and its original date. An authenticated operator must confirm that there is no accepted/performed service, invoice, debt, claim or other need before approving disposal. Repeated checks do not restart the clock. |
| Approved, unheld, conclusively closed unpaid checkout | After 30 days from confirmed closure, remove contact/name/email/brief JSON, all item data including requested domain names, the customer-derived request fingerprint and the checkout URL. Recheck the provider immediately before cleanup. |
| Minimized closed-unpaid payment trace | Keep order/session identifiers, amount/currency, state, relevant dates and accepted terms evidence for reconciliation and possible claims for at most 1,095 days from confirmed closure (approximately three years). This is pseudonymous, **not anonymous**. Then erase the order and its retention row, subject to fresh verification and the same approval/hold/paid safeguards. |
| Manually reconciled case that cannot be freshly verified by session ID | Remains outside automatic erasure. Record the outcome and evidence in restricted operations records, check obligations, and arrange a documented operator-reviewed erasure; never manufacture provider evidence in D1. |

Applicable accounting documents generally need five years from the end of their accounting period for an accounting entity; VAT documents generally need ten years from the end of the relevant tax period where VAT rules apply. Other tax evidence must remain available for the actual assessment/claim period, including lawful extensions. Kitonyo's accounting/VAT status is not inferred by this software. Financial statements and other special records can have different periods. Have the accountant identify the actual records and expiry dates; the periods do not justify keeping every email or project brief. Preserve the authenticity, integrity and readability of required records in the restricted accounting archive.

Paid orders are deliberately not deleted automatically: this application does not know delivery, contract completion, invoice retention or disputes. During the monthly review, record the contract end, archive only necessary financial/claims evidence, and remove no-longer-needed operational materials after their relevant period. The accounting archive must not be the only copy of a required document during a deletion operation.

## Controlled rollout

`ORDER_RETENTION_ENABLED` defaults to `false`, including the tracked Worker configuration. A deployment alone does not authorize cleanup of legacy records. No old record becomes eligible solely because a migration ran.

1. Run local fixture tests and build. Apply `backend/migrations/0001-order-retention.sql` to an existing D1 database; `backend/schema.sql` describes a fresh database. The additive migration must leave existing orders unchanged and may be rerun. Keep cleanup disabled while applying it.
2. In the authenticated D1 console, inventory unresolved records, accepted work, receivables, invoices, complaints and external evidence. Existing `pending`/`creating` records stay unresolved. Protect any relevant closure with `legal_hold=1` and a non-sensitive reason; keep the fuller matter record outside this table.
3. Resolve provider outcomes using authenticated **read-only** provider checks, matching the session ID, order reference, KES currency and exact amount. A browser cancellation, return URL, failed payment attempt or timeout is insufficient. An expired session with a payment object is not automatically disposable. Do not send an actual payment or retry an ambiguous session POST for verification.
4. Inspect each durable closure and approve disposal only after checking that there is no separate contract, performed work, receivable, invoice, complaint or preservation need. First save its ID, closure date, planned erasure stages and any holds in the independent erasure journal described below. The exported `approveClosure` helper requires the observed closure timestamp and explicit `confirmNoObligation:true`; it is intended for a trusted D1-bound operator environment, never a public HTTP route. The guarded console example below is an alternative. Do not place customer details or raw provider payloads in `evidence_ref`.
5. Preview with `runRetention(env, {fetchSession, now, dryRun:true})` in a trusted D1-bound environment with read-only provider access. Inspect aggregate counts and holds. Dry-run must not modify D1, including payment state, approval or attempt timestamps.
6. Only after reviewing the preview and protecting exceptions, set `ORDER_RETENTION_ENABLED=true` in the deployed Worker configuration. Keep the repository configuration in sync to avoid a later deployment undoing that decision. The existing minute cron checks at most ten eligible closures per run; provider errors retain data. Disabling payment creation does not itself prove non-payment or permit erasure.
7. Confirm the deployed commit, applied schema, enabled flag and successful cron counts separately. A green Pages/static-site deployment is not proof that the Worker or D1 migration was deployed. If Worker deployment fails, do not report cleanup as active.

Example migration command (authenticated Cloudflare owner environment; no secrets in arguments):

```text
npx wrangler@4 d1 execute kitonyo-orders --remote --config wrangler.worker.jsonc --file backend/migrations/0001-order-retention.sql
```

## Holds, review and reconciliation

A hold does not expire automatically. Review its necessity at least monthly, record the next review in the restricted matter record, and release it only when the reason ends. Revoking disposal approval also stops cleanup. Approval and closure identity are checked again in the final conditional SQL so a concurrent hold, settlement or changed closure prevents erasure.

Example console approval: replace the review values with one inspected order, its exact observed `closed_at`, the review's UTC epoch milliseconds and an internal non-personal evidence reference. Change `confirmed_no_obligation` to `1` only after the documented review and journal entry. The example defaults to doing nothing; do not remove its guards or approve a batch by age.

```sql
WITH review(order_id,expected_closed_at,reviewed_at,evidence_ref,confirmed_no_obligation)
AS (VALUES('REPLACE_WITH_INSPECTED_UUID',0,0,'review/REPLACE_WITH_CASE_ID',0))
UPDATE order_retention
SET disposal_approved_at=(SELECT reviewed_at FROM review),
    evidence_ref=(SELECT evidence_ref FROM review)
WHERE order_id=(SELECT order_id FROM review)
 AND closed_at=(SELECT expected_closed_at FROM review)
 AND (SELECT confirmed_no_obligation FROM review)=1
 AND (SELECT reviewed_at FROM review)>=closed_at
 AND (SELECT reviewed_at FROM review)<=CAST(strftime('%s','now') AS INTEGER)*1000
 AND closure_kind='provider_expired' AND legal_hold=0 AND invalidated_at IS NULL
 AND last_verified_at>=closed_at
 AND last_verified_at<=(SELECT reviewed_at FROM review)
 AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_retention.order_id
   AND o.session_id=order_retention.session_id AND o.state='expired'
   AND o.paid_at IS NULL AND o.payment_reference IS NULL);
```

To protect an inspected closure, set `legal_hold=1` with an internal case reference in `hold_reason`. When releasing it, clear both the hold and `disposal_approved_at`, then perform a new disposal review. Do not expose these operations as frontend/admin HTTP routes.

After seven days, pending/creating records leave the regular automatic payment-reconciliation window and require merchant review. Use `backend/retention-review.sql` for restricted operational queues and counts; it intentionally omits customer JSON, briefs and domain names. The queries do not delete or change anything. Queueing and monthly review are operator duties, not an email/alert integration. Retention errors and provider outages require follow-up rather than silent unlimited storage.

If fresh provider evidence contradicts an earlier expiry, revoke its disposal approval and retain the record for reconciliation. A matching succeeded payment is recorded as paid instead of being cleaned. `paid_at` or a payment reference blocks cleanup even if the local state is corrupt. Unknown schemas or absent provider configuration fail closed and retain data. An unresolved missing-session order cannot be made safe by editing its age or status alone.

## Backups, exports and restoration

Apply the same purpose/hold schedule to exports, email attachments and restricted archives. Keep an access-controlled erasure journal outside the database being restored, containing only the identifiers, approved requests, completion dates and erasure actions needed to replay removals. Export the restricted journal input before approval, then reconcile `redacted_at`/missing rows and aggregate cron results after each batch. This release does not automatically export a journal to another service: maintaining it is a rollout prerequisite and operator duty. Retain replay entries through the longest outstanding recovery/export window, then remove them unless an actual claim requires them; do not copy erased briefs or contact information into the journal.

D1 Time Travel is always on for supported production databases and can expose earlier data within the account's recovery window (up to 30 days; check the actual plan). Logical erasure is not an immediate physical wipe of recovery history. Restrict backup use to recovery, allow old versions to age out, and do not use them for normal operations. After restoration, keep checkout and retention disabled while replaying all later erasures and holds from the independent journal, checking payment outcomes and reapplying the current migration. Reconcile required accounting records before reopening service. Restoring D1 can otherwise resurrect removed personal data or revert payment states.

Rollback of code is safe with the additive table left in place, but it does not undo completed redactions. Never restore erased personal data merely to undo a release. First disable retention, preserve/replay the erasure journal, and investigate the specific issue.

## Sources

- [GDPR Articles 5, 6, 13 and 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj): purpose limitation, storage limitation, transparency and legal/claims exceptions.
- [Czech data-protection authority: information for e-shops](https://uoou.gov.cz/profesional/qa-otazky-a-odpovedi/informace-pro-e-shopy).
- [Czech Financial Administration: electronic accounting/tax records](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/uctenky-v-elektronicke-podobe-3831).
- [PayNecta checkout sessions](https://docs.paynecta.co.ke/api/checkout-sessions/) and [payment outcomes](https://docs.paynecta.co.ke/concepts/how-a-payment-works/).
- [Cloudflare D1 recovery history](https://developers.cloudflare.com/d1/reference/time-travel/).
