import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy policy", description: "How Romanum handles your data and the controls available to you." };

const LINK = "text-fg underline underline-offset-4 hover:text-white";
const sections = [["collection", "What we collect"], ["ai", "AI requests"], ["ads", "Imported ad reports"], ["games", "Connected games"], ["providers", "Service providers"], ["cookies", "Cookies"], ["retention", "Storage & deletion"], ["choices", "Your choices"], ["contact", "Contact"]];

export default function PrivacyPage() {
  return <article className="mx-auto max-w-3xl pb-12">
    <header>
      <p className="text-sm text-fg-muted">Updated 4 October 2026</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="mt-5 leading-relaxed text-fg-muted">Romanum is a Roblox development platform based in Australia. This policy covers the Romanum website and its services. Contact us at <a href="mailto:help@romanum.dev" className={LINK}>help@romanum.dev</a>.</p>
    </header>
    <div className="mt-7 rounded-xl border border-line p-5 text-sm leading-relaxed">
      <p>Public analytics work without signing in. Conversations are private to your account or signed guest identity; projects are private to your account. Connected-game sharing is optional and off by default. AI requests go to a model provider.</p>
      <Link href="/profile/data" className={`mt-3 inline-flex min-h-11 items-center ${LINK}`}>Manage your data</Link>
    </div>
    <nav aria-label="Privacy policy sections" className="mt-7 flex flex-wrap gap-x-5 gap-y-3 text-sm text-fg-muted">
      {sections.map(([id, title]) => <a key={id} href={`#${id}`} className="hover:text-fg underline-offset-4 hover:underline">{title}</a>)}
    </nav>
    <div className="mt-10 space-y-10 text-sm leading-7 text-fg-muted [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-fg [&_p+p]:mt-3 [&_section]:scroll-mt-8">
      <section id="collection">
        <h2>What we collect and why</h2>
        <ul className="list-disc space-y-3 pl-5">
          <li><strong className="text-fg">Roblox profile:</strong> signing in gives us your Roblox user ID, username, display name and profile picture. We use these to identify your account, sign you in and apply credits. We do not receive your Roblox password.</li>
          <li><strong className="text-fg">Content you provide:</strong> saved chats, uploaded images, project briefs, asset plans, imported ad reports, creative associations, saved observations, game watches, alert rules and development experiments, including their evidence and release dates. We store this to provide the features you use and let you return to your work.</li>
          <li><strong className="text-fg">Usage records:</strong> credit grants, reservations, spending, model and tool names, token counts and timestamps. These support metering, error investigation and prevention of repeated sign-up bonuses or weekly refills.</li>
          <li><strong className="text-fg">Technical information:</strong> cookies, request details, IP addresses, browser information and errors processed by our hosting and security providers to deliver and protect the service.</li>
          <li><strong className="text-fg">Support:</strong> if you email us, we receive your address and message so we can respond.</li>
        </ul>
        <p>We also collect public Roblox experience information, including names, creators, icons, player counts and historical observations, to provide analytics. This public dataset is separate from private connected-game analytics.</p>
        <p>Saved watches and experiments are private to your account or signed guest identity. Watches use public observations to check your rules and save alerts in Romanum; they do not send messages elsewhere. These records are included in account exports and removed when you delete their watch, experiment or account. Saving a watch can add its public game to the bounded public collection cohort; the public history does not disclose who saved it.</p>
      </section>
      <section id="ai">
        <h2>AI requests</h2>
        <p>Ask Romanum and Chats use the model selected for your request. Sending a message sends its text, relevant conversation history, retrieved information and any images attached to that message to the selected model provider. In a project chat, the project brief is also included. Images are resized and their embedded metadata is removed before they are stored and sent.</p>
        <p>Chats and Ask Romanum on analytics save conversations privately under your account or signed guest identity. You can reopen or delete these conversations in Chats. Take this to chat opens the same conversation, including its saved context. Your browser remembers only its ID for returning to Ask on that analytics page; clearing the guest cookie can prevent returning to a guest conversation. Saved chat images are not automatically sent again in later messages.</p>
        <p>For accounts with AI analysis enabled on a connected game or a project&apos;s imported ad reports, Chats can continue a response in the background after you leave the page. We temporarily store the question, relevant context and references to its attachments, and save private progress so you can reopen the chat. Use Stop to request cancellation. Temporary queued context is cleared when the review ends; saved progress and answers remain with the chat until deletion.</p>
        <p>Project reference images stay in your private library. Choosing one in a chat copies it into that message; sending the message sends that copy to the selected model provider. Removing the library image does not remove copies already saved in chats.</p>
        <p>Private game analytics reach the assistant only when you enable <strong className="text-fg">AI analysis</strong> for that linked game. When you ask about it, relevant aggregate metrics and breakdowns can be retrieved with your stored key and sent to the selected model provider. These can include funnels, device performance, retention, engagement, monetization, acquisition, economy and custom events. The API key itself is never sent to the model. If you paste private metrics into a message, that content is sent with your request regardless of the game&apos;s switches.</p>
        <p>Private results and answers are retained in saved chats. Turning AI analysis off stops new private analytics reads; it does not remove earlier answers or recall provider requests. Earlier answers can still be included in later conversation history. Previous private tool payloads are withheld from subsequent turns; a new lookup needs current permission. Delete the chat to remove its saved copy.</p>
        <p>DeepSeek handles requests under its applicable terms. Romanum has not established a zero-retention or no-training arrangement with DeepSeek, so we do not make either promise. Avoid sending passwords, API keys, sensitive personal information or personal information about children in chats.</p>
      </section>
      <section id="ads">
        <h2>Imported ad reports</h2>
        <p>Ad reports you upload to a project, their source cells and file hashes, creative-image associations and saved observations are private to your account. Uploading a report does not enable AI analysis. The project&apos;s separate <strong className="text-fg">Allow AI analysis</strong> setting is off by default. Enabling it permits relevant report metrics, associations and private notes to be sent to the selected model provider when you ask project chat to use that evidence.</p>
        <p>Turning permission off stops future imported-evidence reads. Previous private tool payloads are withheld from later turns, but written answers and saved plans remain and can appear in conversation history. An image association supplies metadata; sending its pixels requires choosing that reference as a chat attachment. Platform-improvement sharing is unavailable for imported reports. Your learning records do not automatically change shared skills.</p>
        <p>Deleting a report removes its creative associations and dependent saved observations. It does not remove earlier written chat copies or recall provider requests. Reports, learning records and consent history are included in your account export and removed from the active database when you delete your account.</p>
      </section>
      <section id="games">
        <h2>Connected games</h2>
        <p>Linking a game provides its universe ID and a Roblox API key. We encrypt the key in storage and use it to request the game&apos;s authorised aggregate analytics, such as daily players, session length, playtime, retention, revenue and payer conversion. This integration does not collect individual player identities.</p>
        <p><strong className="text-fg">Collect analytics</strong> controls future collection. Turning it off keeps previously collected records. Disconnecting removes the saved key; deleting a linked game also removes its saved metrics.</p>
        <p><strong className="text-fg">AI analysis</strong> is off by default and separate from improvement sharing. It permits owner-only analysis through Ask Romanum and Chats while collection is on and the game is connected. Private results do not enter public pages, public MCP tools or shared analytics caches. Changing access during a query discards the pending result. Deleting a linked game does not delete earlier copies in your chats.</p>
        <p><strong className="text-fg">Help improve Romanum</strong> is off by default. It records whether your metrics may be included in platform-improvement analysis. No feature currently uses these shared metrics. Turning it off removes them from that access immediately. We record changes to these settings to keep a consent history.</p>
        <p>Turning these settings off does not stop collection of information already public on Roblox. We will update the notice before introducing a new use of private metrics.</p>
      </section>
      <section id="providers">
        <h2>Service providers and overseas processing</h2>
        <p>Romanum uses the following providers to operate the service. They receive the information needed for their role and may also process operational records under their own policies.</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li><a className={LINK} href="https://www.netlify.com/privacy/">Netlify</a> hosts the website and server functions, processing requests and application data.</li>
          <li><a className={LINK} href="https://www.salesforce.com/company/privacy/">Heroku / Salesforce</a> hosts our PostgreSQL database. The current database is in the United States.</li>
          <li><a className={LINK} href="https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html">DeepSeek</a> processes AI requests. DeepSeek is based in China and describes processing and storage there; AI content may therefore be processed in China.</li>
          <li><a className={LINK} href="https://www.cloudflare.com/turnstile-privacy-policy/">Cloudflare Turnstile</a> checks for automated abuse. It processes information such as IP address, browser signals and the site being visited, including for improving bot detection.</li>
          <li><a className={LINK} href="https://en.help.roblox.com/hc/en-us/articles/115004630823-Roblox-Privacy-and-Cookie-Policy">Roblox</a> provides sign-in, experience information, authorised analytics and remotely loaded Roblox images.</li>
        </ul>
        <p>Hosting, security and Roblox services operate internationally, including in the United States. Their networks and support operations may process information in other countries. Data is not confined to Australia.</p>
        <p>Romanum does not sell your personal information. We may disclose information when required by law or when necessary to address fraud, security incidents or legal claims.</p>
      </section>
      <section id="cookies">
        <h2>Cookies</h2>
        <p>Romanum uses a guest cookie to keep a guest&apos;s credits and work together, a session cookie to keep you signed in, and a short-lived cookie to complete Roblox sign-in. Their maximum lifetimes are one year, 30 days and 10 minutes respectively. Browser settings let you remove or block them, though sign-in and guest continuity may then stop working.</p>
        <p>Cloudflare may process browser storage or cookies for its security checks. Romanum does not currently run advertising cookies or third-party marketing analytics.</p>
      </section>
      <section id="retention">
        <h2>Storage and deletion</h2>
        <p>Saved account content stays in the application database until you delete it or your account. There is no automatic expiry for inactive accounts or guest content at present. Access to private records is checked against the account or guest identifier; game API keys are encrypted separately.</p>
        <p>Deleting your account removes its profile, saved chats and images, projects and plans, watches and alerts, development experiments, linked game keys, private metrics and consent history from the active database. All its sign-in sessions are revoked. A request already sent to an AI provider cannot be recalled by deleting the account.</p>
          <p>We retain credit, model and tool-usage records for accounting, resolving outstanding usage and preventing abuse. They include an internal owner identifier and, for sign-up grants and weekly refill records, your Roblox user ID. We also retain a closure marker containing internal account identifiers and the deletion date so stale requests cannot recreate your content. These records do not contain your chat text or images.</p>
        <p>There is currently no automatic expiry for these retained records. You can ask us to review their continued retention. Provider logs, provider-held AI requests and backup copies follow separate retention processes; account deletion does not immediately erase them. We do not promise a fixed deletion deadline for those copies.</p>
        <p>Public Roblox history is retained independently. If unfinished creation work or another user&apos;s licensed asset copy prevents automatic deletion, the request leaves your account intact and directs you to support for review. Returning after deletion creates a new account; old credits and the sign-up bonus are not restored.</p>
      </section>
      <section id="choices">
        <h2>Your choices</h2>
        <p>You can browse public analytics without signing in, use game collection and sharing controls in <Link className={LINK} href="/profile#games">your profile</Link>, and download or delete your account through <Link className={LINK} href="/profile/data">Your data</Link>.</p>
        <p>For access, correction, guest-data deletion or another privacy request, email help@romanum.dev. We may need to verify that the records belong to you, but do not send passwords, API keys or identity documents with your initial request. Roblox profile details refresh when you sign in again after changing them on Roblox.</p>
        <p>Romanum is a development tool. We do not request a date of birth or collect children&apos;s player profiles through connected analytics. A parent or guardian can contact us about a child&apos;s account or information.</p>
      </section>
      <section id="contact">
        <h2>Contact and complaints</h2>
        <p>Email <a className={LINK} href="mailto:help@romanum.dev">help@romanum.dev</a> with your request or concern. We will review it, seek any details needed to investigate and explain the outcome. If Australian privacy law applies and you are not satisfied with our response, you can contact the <a className={LINK} href="https://www.oaic.gov.au/privacy/privacy-complaints/lodge-a-privacy-complaint-with-us">Office of the Australian Information Commissioner</a>.</p>
        <p>We will update this page when our practices change, with the date shown above. A new purpose for optional private-data sharing will have an updated notice before it is enabled.</p>
      </section>
    </div>
  </article>;
}
