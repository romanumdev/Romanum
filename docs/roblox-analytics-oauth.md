# Optional Roblox analytics authorization

This local implementation is prepared for review. New OAuth connections are disabled unless
`ROBLOX_ANALYTICS_OAUTH_ENABLED=true` and the existing Roblox OAuth client is
configured. No app registration, permission change, user grant, production
migration or deployment was performed as part of preparing it.

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

## Official references checked

- [Roblox Analytics API endpoints](https://create.roblox.com/docs/cloud/reference/domains/apis)
- [Roblox OpenAPI specification](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/cloud/openapi.json)
- [OAuth app registration and permission review](https://create.roblox.com/docs/cloud/auth/oauth2-registration)
- [OAuth token, refresh and resource reference](https://create.roblox.com/docs/cloud/auth/oauth2-reference)
- [Creator Third-Party App Policy](https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy)
- [Creator Third-Party App Terms, section 10](https://en.help.roblox.com/hc/en-us/articles/15887203369620-Creator-Third-Party-App-Terms)
