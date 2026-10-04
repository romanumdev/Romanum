import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms of service", description: "Draft terms for using Romanum analytics, AI tools and connected-game features.", alternates: { canonical: "https://romanum.dev/terms" } };
const LINK = "text-fg underline underline-offset-4 hover:text-white";

export default function TermsPage() {
  return <article className="mx-auto max-w-3xl pb-12">
    <header>
      <p className="text-sm text-fg-muted">Draft for review · Updated 4 October 2026</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Terms of service</h1>
      <p className="mt-5 leading-relaxed text-fg-muted">These draft terms describe use of Romanum&apos;s website and development tools. Romanum is based in Australia. Questions about the service or these terms can be sent to <a href="mailto:help@romanum.dev" className={LINK}>help@romanum.dev</a>.</p>
    </header>
    <div className="mt-7 rounded-xl border border-line p-5 text-sm leading-relaxed text-fg-muted">
      <p>This draft is available for review before publication of final terms. It does not change your existing permissions, enable payments or record acceptance of new terms.</p>
      <Link href="/privacy" className={`mt-3 inline-flex min-h-11 items-center ${LINK}`}>Read the privacy policy</Link>
    </div>
    <div className="mt-10 space-y-8 text-sm leading-7 text-fg-muted [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-fg [&_p+p]:mt-3">
      <section><h2>Using Romanum</h2>
        <p>Romanum provides public Roblox analytics, read-only MCP access, AI assistance and tools for saving development work. Public analytics and public MCP access are free. Features depend on available data, configured integrations and service capacity.</p>
        <p>Use only accounts, games, reports and content that you own or are authorised to use. Roblox sign-in uses Roblox&apos;s authorisation flow; Romanum does not receive your Roblox password. Roblox requires a 13+ account to authorise OAuth apps. Follow Roblox&apos;s applicable rules when using its accounts, services or content.</p>
        <p>Guest work is associated with a signed browser identity. Clearing its cookie may prevent access to saved work and credits. Keep copies of work that matters to you.</p>
      </section>
      <section><h2>Acceptable use</h2>
        <p>Do not use Romanum for unlawful activity, infringement, harassment or unauthorised access. Do not bypass verification, access controls, usage limits or credit checks; exploit repeated grants; interfere with the service; or try to access another person&apos;s private records. Do not submit passwords, unrelated API keys or sensitive personal information through AI messages.</p>
      </section>
      <section><h2>Your content and AI assistance</h2>
        <p>You retain your rights in the content you provide. You must have permission to upload it and allow Romanum and the relevant service providers to process it for the features you request, as described in the <Link href="/privacy" className={LINK}>privacy policy</Link>. Saving content privately does not make it public.</p>
        <p>AI messages, relevant context and selected attachments are sent to the selected model provider. Review generated answers, code, briefs and assets before using them. Outputs can be inaccurate, incomplete or similar to other work; generation does not establish ownership, originality or permission to use third-party material.</p>
        <p>Romanum&apos;s <a href="https://github.com/romanumdev/Romanum/blob/main/LICENSE" className={LINK}>source-available licence</a> separately covers its published code and skills, including its permission for eligible commercial game and creative outputs. These terms do not replace that licence or third-party licences.</p>
      </section>
      <section><h2>Credits and requests</h2>
        <p>Integrated AI and enabled generation features use Romanum credits. One credit represents US$0.01 of service usage, not Robux. A request may reserve credits while it runs, with recorded usage determining its final cost. Costs depend on the model and applicable pricing policy; review the displayed balance and usage receipts.</p>
        <p>Free grants and refills follow the eligibility and limits shown in the service. Creating another guest identity or deleting an account does not entitle you to repeat an account bonus. Romanum does not currently offer credit checkout or subscriptions. Any future purchase terms will be presented before purchases become available.</p>
        <p>If you believe usage was charged incorrectly, contact help@romanum.dev with the request details. Do not include passwords or secret keys.</p>
      </section>
      <section><h2>Analytics and connected data</h2>
        <p>Public charts describe the observations collected, with gaps and limited coverage. Earnings estimates are modelled assumptions, not actual revenue. Watches depend on complete observations and capacity; alerts are not guaranteed. Release comparisons describe before-and-after activity and do not prove that an action caused a change.</p>
        <p>Connecting a game, collecting private metrics and allowing AI analysis have separate controls. Only connect resources you are authorised to manage. Turning permission off stops new authorised reads; it does not recall earlier provider requests or remove previous written answers. See the privacy policy for storage, export and deletion details.</p>
      </section>
      <section><h2>Service changes and your rights</h2>
        <p>Features may be interrupted by maintenance, provider outages, unavailable observations or capacity limits. Romanum may restrict misuse or access that threatens the service or other users. Contact support if you believe a restriction is mistaken.</p>
        <p>You can stop using Romanum and manage export or account deletion through <Link href="/profile/data" className={LINK}>Your data</Link>. Deletion and retained usage records are explained in the privacy policy.</p>
        <p>Nothing in these terms excludes or limits rights or remedies that cannot be excluded under applicable law, including applicable Australian Consumer Law guarantees.</p>
        <p>Changes to these terms will be published here with an updated date. Questions or concerns can be sent to <a href="mailto:help@romanum.dev" className={LINK}>help@romanum.dev</a>.</p>
      </section>
    </div>
  </article>;
}
