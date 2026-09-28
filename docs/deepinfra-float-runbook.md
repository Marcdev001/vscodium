# DeepInfra Float Runbook

## The Two Money Flows

1. **User to Albion:** Paystack or Lemon Squeezy collects a subscription payment. A signed webhook activates the user's tier in Supabase. The proxy enforces that user's per-model token caps.
2. **Albion to AI providers:** Paid model requests consume Albion's provider balance. DeepInfra bills Albion's account, not the individual user's account. Subscription revenue is Albion revenue; provider spend is a separate business expense.

The proxy's caps limit usage per account, but they do not reserve or automatically transfer subscription revenue to DeepInfra. Monitor provider spend and reconcile it against `usage_logs` regularly.

## Before Launch

- Verify current DeepInfra billing options in the account dashboard; availability and labels may change.
- If automatic top-up is available, configure a low-balance threshold of **$10** and a **$25** top-up amount, and confirm the payment method and notification settings.
- Test a small paid inference call and confirm it appears in both the provider dashboard and the Albion usage ledger.
- Run `node albion-verifier/scripts/billing-reconciliation.js --month=YYYY-MM` for the matching UTC month. Compare the reported DeepInfra-model estimate with the corresponding DeepInfra dashboard period; investigate discrepancies before increasing traffic.

## Initial Float Rule

For the alpha, cap initial working float at **$20–$50**. Prefer funding it from collected subscription revenue. Any founder-funded amount should remain minimal working capital, be explicitly tracked, and not be treated as guaranteed recoverable. Do not launch paid inference until the spend limit, usage logging, and fallback behavior have been verified.

The reconciliation script reports application-level usage costs against the plan's USD list price. It does not include payment fees, refunds, taxes, infrastructure, or provider spend that failed to reach `usage_logs`; therefore its margin is an operational indicator, not a complete accounting statement.