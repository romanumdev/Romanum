# Privacy operations

The public policy is served at `/privacy` from `src/app/privacy/page.tsx`. Keep its data flows and provider list aligned with the deployed configuration. Policy links are available in settings and the analytics footer. The page describes current behaviour; it is not a claim of legal compliance.

## Account closure

`POST /api/account/delete` requires an authenticated session, an exact same-origin JSON request, the current account ID and `confirmation: "DELETE"`. The client asks for confirmation before sending it. No account identifier supplied by a client can override session ownership.

Migration 017 and `src/lib/accounts/closure.ts` remove the account's private records atomically. Sessions, game keys, private metrics and consent records cascade from the account. Chats, image attachments, project briefs, plans, private assets and internal creation records are also removed. Public Roblox observations and other accounts are untouched.

Migration 021 adds private background chat reviews. Deleting a chat/account cascades its queued context and recorded progress; a worker checks cancellation/deletion before each model/tool attempt and aborts ongoing work when detected. A request already sent to a provider can still complete and settle. Leaving a page does not cancel a review; Stop does. Temporary queued context is cleared when the run ends, while recorded progress and the saved answer remain until deletion and are included in account exports. Claim tokens and leases are not exported. Expired work preserves partial output without automatically retrying an ambiguous provider call.

Writes to owner-scoped content take an advisory transaction lock and reject a closed owner. This prevents a request authorised before closure from restoring content afterward. Child rows remain protected by parent foreign keys. New credit grants and reservations are rejected for closed owners; previously reserved usage can still settle. Apply migration 017 before deploying callers that query `account_closures`.

The retained credit ledger includes the Roblox user ID in a sign-up grant's idempotency key. The closure marker and financial records are pseudonymous, not anonymous. Returning creates a new owner and does not transfer the previous balance or issue another Roblox sign-up bonus. Old adopted-guest cookies cannot recover the former owner.

## Requests requiring support

Migration 022 adds private imported ad reports, explicit project-image associations, source-cited learning records and independent versioned AI consent. Account closure cascades these records; account export includes their contents and consent history. Imported-ads AI analysis is off by default and sends relevant metrics/notes to the selected model provider only through owner project chat. Revocation/source deletion is checked before subsequent model requests. Earlier written answers/plans are retained independently; deleting a source report removes dependent learning records but does not recall chat/provider copies. Platform-improvement sharing is unavailable, and project notes do not change shared skills. See [ad reports](ad-reports.md) for the validated formats and limits.

- Verify control of the account or guest identity without requesting passwords or API keys by email. Scope every query and mutation to that verified owner.
- If unresolved generation jobs, reviews or agent runs block closure, reconcile them before retrying. Do not bypass uncertain billing outcomes.
- If another owner's library entry depends on an asset being removed, review the rights and deletion request before changing lineage. Do not delete another owner's licensed copy automatically. Marketplace sharing is not exposed by the current website.
- Deleting a linked game removes its key and metrics. Its consent log remains until account closure. Collection-off, AI-analysis-off and sharing-off have separate meanings and are not deletion requests. AI analysis is a separate opt-in for owner queries sent to the selected model provider (DeepSeek, OpenAI or Anthropic). New choices record notice version 2026-10-07; historical consent rows and existing choices are not rewritten. AI analysis remains off by default. Turning it off stops new reads and discards in-flight results. Earlier written answers remain in chats and can still be sent as conversation history; previous private tool payloads are withheld from later turns. Deleting a linked game does not remove earlier chat copies; delete the chat to remove its saved copy. Export includes the AI-analysis flag and consent history.
- Review requests about retained credit records separately. Preserve necessary settlement and anti-abuse records only where there is a justified continuing need; do not describe an indefinite database default as a legal requirement.
- Application deletion does not recall provider requests or erase provider logs and backups. Check the relevant provider arrangements before promising a deadline. A database restore must preserve/reapply closure records and completed deletions before reopening the service.

## Release review

Confirm the legal operator identity and any required public identification, the privacy laws that apply, age-related requirements, provider contracts and AI retention/training terms. Establish retention periods and a workable purge/backup process; inactive and retained accounting records currently have no automatic expiry. Confirm the support mailbox works and assign responsibility for access, correction, deletion, complaints and incidents. Update collection notices before private analytics enter an AI request or platform-improvement feature.

Australian reference: OAIC guidance on [privacy policies](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-1-app-1-open-and-transparent-management-of-personal-information), [collection notices](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-5-app-5-notification-of-the-collection-of-personal-information) and [small-business coverage](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business). Applicability must be assessed rather than inferred from the platform's size.

### AI provider checks for the analytics release

Roblox's [app data-use policy](https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy) prohibits using user data to train AI models. A user's AI-analysis switch permits the requested inference; it is not permission for model training.

- **OpenAI:** its [API data controls](https://developers.openai.com/api/docs/guides/your-data) exclude training by default unless the customer opts in. Confirm that the API organisation/project used by Romanum has not enabled data sharing. The local Responses adapter uses `store:false` and `background:false`; those flags do not establish Zero Data Retention or remove abuse-monitoring logs.
- **Anthropic:** its [commercial terms](https://www.anthropic.com/legal/commercial-terms) prohibit training on customer content from the covered services. Confirm the applicable API account agreement. Romanum uses Messages, with global inference for its supported frontier models; no Australian-only processing or zero-retention arrangement has been verified.
- **DeepSeek:** its [Open Platform terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html) apply to API integrations and incorporate its general terms. The published API terms do not establish a blanket no-training commitment. Obtain confirmation that an opt-out or agreement covers Romanum's API inputs and outputs before clearing this release item. A consumer-chat setting alone is not proof of API coverage.

These account arrangements were not verified by the source review on 7 October 2026. Keep the production OAuth connection flag disabled while app approval, policy publication and provider arrangements remain unresolved. Credential presence, synthetic tests and a successful build do not establish those arrangements.

## Validation

Account-closure tests exercise the full migrated schema, ownership, deletion rollback, active-work restrictions, licensed-copy dependencies, retained settlements and stale-write rejection. HTTP tests cover CSRF, request limits, account switches, session revocation and repeat Roblox sign-in. Use only isolated test accounts for end-to-end deletion checks. Never delete a production account as a deployment smoke test.
