# Optional Roblox analytics authorization

New OAuth connections are disabled unless
`ROBLOX_ANALYTICS_OAUTH_ENABLED=true` and the existing Roblox OAuth client is
configured. Deploying the integration and applying its database migration do not
activate Roblox permissions or authorize any user's game.

## Permissions and setup

Before activation, obtain the owner's approval for app configuration and release.
Apply the additive `027_linked_game_oauth.sql` migration through the existing
migration workflow before deploying this code, including a release with new
connections disabled. Game reads also use the new table. It adds encrypted credential storage without changing or
deleting existing games, metrics, choices or API keys.

For the existing OAuth app, use the **Analytics & Insights Tools** category and
only the identity scopes `openid`, `profile` and API scope
`universe.analytics:read`. The analytics scope is used by both metric and
dimension-value queries and their operation polls. Dashboard, advertising,
write and unrelated resource scopes are not needed for this integration.

Keep the existing registered callback (`ROBLOX_REDIRECT_URI`, or
`/auth/roblox/callback` on the request origin). The connection uses this same
callback and a separate signed, ten-minute attempt cookie. Ordinary sign-in
continues to request only `openid profile` and discards its tokens after identity
verification. It does not grant private analytics access.

Adding scopes requires new user authorization; existing sign-in tokens cannot
gain permissions automatically. A public app requires Roblox review for updated
permissions. Final privacy and Terms URLs, app disclosures and the actual consent
flow must be reviewed before submitting the app. The Terms page remains a
separate working draft while operator wording is unresolved. Do not enable the
feature merely because local mock tests pass.

## App review submission

Open the app under [Creator Dashboard credentials](https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab).
Check whether the analytics permission is absent, pending review or approved;
the existence of a working sign-in app does not establish analytics approval.
An app with a pending public review cannot be edited until that review finishes.

Use this description and scope justification after checking that they match the
configured app and the demonstrated release:

> Romanum helps Roblox developers understand their own experience analytics.
> Developers optionally connect a specific experience through Roblox, view
> aggregate metrics and separately choose whether to let an AI analyse them.
> Public Roblox analytics remain available without a private game connection.

> `openid` and `profile` identify the account during sign-in and ensure that a
> game connection returns to the same account. `universe.analytics:read` lets
> Romanum request aggregate engagement, retention, monetization, acquisition,
> funnel and client/server performance metrics, their dimension values and query
> operation results for explicitly authorised universes. The integration does
> not request write access, individual player identities or advertising access.

The registered production callback is `https://romanum.dev/auth/roblox/callback`.
Use `https://romanum.dev/privacy` for the published privacy policy. A final Terms
page still needs publication; do not submit a placeholder or a private review
draft as the public Terms URL. Roblox's App Terms require wording covering its
relationship to the app, responsibility and support, user compliance with
Roblox's terms, and release of claims against Roblox. Finalise operator wording
and review those clauses before publication.

The public-app review also needs a public demonstration video of at most one
minute. Record the actual flow, starting signed out: sign in, open game settings,
start the optional game connection, show the complete Roblox consent screen and
return to the connected game in Romanum. Show collection and AI analysis as
separate choices. Use an authorised test experience and keep credentials out of
the recording. Use a permitted private test configuration to demonstrate the
flow before public approval; do not enable an unapproved app for general users.
The registered callback, screenshots, wording and requested scopes must match
the demonstrated app.

Before public activation, verify app approval, the final policy URLs, the
production migration and the registered callback. Setting an environment flag
does not grant Roblox permission. Reauthorisation is required for each user's
new scope; existing sign-in sessions do not gain access automatically.

`scripts/analytics-schema-release.mjs <exact-main-commit>` is an optional,
read-only production build check for migration 027. It reuses the existing
Netlify site and database-target checks, validates the role and migration
checksums, and checks analytics table access, OAuth columns/cascade and provider
accounting availability. It reads schema metadata only and runs no migrations.
It is not part of the normal build. When using it for a specific release, bind
the temporary build command to that exact commit and restore `npm run build`
afterward. Its output contains booleans and the commit, never credentials or
private game records. A passing schema check still does not prove app approval
or a successful private analytics query. See [provider checks](privacy-operations.md#ai-provider-checks-for-the-analytics-release)
for the separate data-use requirements.

After those prerequisites are approved and verified, enabling the flag exposes
the optional **Connect through Roblox** action in game settings. Users enter a
universe ID, authorize it on Roblox and return under the same Romanum account.
The callback verifies the Roblox identity, required read scope and explicit
numeric universe grant. Group-owned resources retain their group owner identity;
wildcards or creator-only resource markers do not authorize an arbitrary game.

## Existing connections and data

New API-key submissions are rejected. Existing sealed keys continue to support
legacy connections until the owner explicitly reconnects, disconnects or deletes
the game. Reconnecting through OAuth keeps the same game ID, metrics and
collection, AI and sharing choices. It also retains the old encrypted key until
disconnect or deletion; that retained key is never used as fallback after an
OAuth connection fails.

OAuth access and rotating refresh tokens are encrypted for the account and game.
Refreshes are serialized; replacement credentials are committed before checking
resources. An ambiguous refresh is not retried with its consumed token. Failed
resource checks preserve the rotated credential, and lost authorization requires
an explicit reconnect. Credentials are never returned to the browser or sent to
the model. Disconnect removes Romanum's stored credentials; it does not revoke
the Roblox app grant remotely.

Collection and AI analysis retain their existing separate controls and consent
checks. Local verification uses synthetic identities, resources and tokens;
production OAuth success and access to actual analytics have not been tested.
OAuth support for the existing API operations does not guarantee every metric
is available for every experience.

## Reviewing a connected game

After app approval and activation, open `/profile/settings/games`, use **Connect
through Roblox** for the experience's universe ID, and authorize that universe
under the same Roblox account used to sign in to Romanum. Enable **Collect
analytics** and **AI analysis** for the game; these are separate owner choices.
An existing legacy connection can still be reviewed while new OAuth connections
remain disabled.

Open a saved Chat and ask for a review of that game's funnels, retention,
engagement, monetization, acquisition and client/server performance. Saved Chats
allow the review to continue in the background, preserve progress on reopening,
and offer Stop. Ask Romanum also supports private queries, but its live request
has a shorter lookup budget.

The assistant should first list the account's linked games, then read its cached
baseline and fetch relevant fresh metrics and dimension values. Expect findings
to include date windows, cohort labels, missing or insignificant points and
which categories were actually queried. Funnel, economy and custom-event data
require the experience to have logged those events. Ads Manager creative results
can be imported separately; detailed crash snapshots and MicroProfiler captures
are not provided by the Analytics Query API.

For a live release check, verify a successful authorized lookup with its actual
game and date range, then verify that turning AI analysis off blocks another
private lookup. Check disconnect and rejected/expired authorization without
falling back to a retained legacy key. Synthetic OAuth and metric fixtures cover
these paths locally, but do not prove Roblox has approved the app or that a real
experience has data for every metric.

## Official references checked

- [Roblox Analytics API endpoints](https://create.roblox.com/docs/cloud/reference/domains/apis)
- [Roblox OpenAPI specification](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/cloud/openapi.json)
- [OAuth app registration and permission review](https://create.roblox.com/docs/cloud/auth/oauth2-registration)
- [OAuth token, refresh and resource reference](https://create.roblox.com/docs/cloud/auth/oauth2-reference)
- [Creator Third-Party App Policy](https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy)
- [Creator Third-Party App Terms, section 10](https://en.help.roblox.com/hc/en-us/articles/15887203369620-Creator-Third-Party-App-Terms)
