# Security Policy

Thanks for taking the time to look at Proton Pulse and report anything you find. Real research keeps this project safe for the people who use it.

## Reporting a vulnerability

**Preferred: private GitHub security advisories.** Open one at
<https://github.com/mdeguzis/proton-pulse-web/security/advisories/new>. Only
the repo owner sees it and you get a private discussion thread to work through
the fix.

**Fallback: email.** Send to <mdeguzis@gmail.com> with the subject line
`[SECURITY] Proton Pulse:` followed by a short summary. Encrypt if you like
(PGP key on request), but not required.

**Please do NOT open a public GitHub issue** for anything that could be used
to attack real users. Once a fix has landed and users have had a chance to
update, we are happy to co-publish an advisory that credits your work.

## What to include

A tight report gets triaged faster:

- What the issue is (one sentence).
- Reproduction steps or a small proof of concept.
- Impact (what an attacker gains, who is affected).
- Anything you already know about a fix.

Screenshots and short video captures are welcome. Do not include real user
data in your report; anonymize identifiers before sharing.

## Response commitments

- **Acknowledge within 72 hours** of receipt.
- **Initial assessment within one week** with either a fix plan or a
  request for more information.
- **Status updates** every week until the issue is closed.
- **Coordinated disclosure** once the fix is deployed and users have had a
  reasonable window to update.

## Scope

**In scope:**

- <https://www.proton-pulse.com> and the staging preview at
  <https://mdeguzis.github.io/proton-pulse-web-staging/>
- Supabase edge functions under `supabase/functions/`
- Data pipeline scripts under `scripts/pipeline/`
- GitHub Actions workflows under `.github/workflows/`
- The public Steam profile lookup path (edge fn `public-steam-profile`)

**Out of scope:**

- Steam / Valve infrastructure (please report to Valve directly).
- Discord, jsDelivr, and other third-party CDNs Proton Pulse links to.
- Supabase platform bugs (report to Supabase; we'll happily coordinate on
  anything that intersects with our config).
- ProtonDB itself. We consume their public data but do not operate it.
- Social engineering of Proton Pulse maintainers or contributors.
- Any test that requires DoS, spam, or degrading service for other users.

## Safe harbor

Good-faith security research done under this policy is welcome. Specifically:

- We will not initiate legal action against you for research that stays
  within the scope above.
- We will not report you to law enforcement for good-faith research.
- If you accidentally cross a line while investigating (e.g. you access
  data that is not yours), stop and tell us; we will treat that as part of
  the report, not a violation, so long as you did not exfiltrate or share
  the data.

Please stay within the following bounds:

- Do not attempt to access, modify, or destroy data that is not yours.
- Do not run scans that meaningfully degrade the service for other users.
- Do not use social engineering against maintainers.
- Give us a reasonable window to fix before public disclosure. Default is 90 days, negotiable.

## What we ship to keep the site safe

For context on the automated gates in place, see the
[Safety and Security](https://www.proton-pulse.com/about.html#safety) section
of the About page and the
[Security Guardrails](https://github.com/mdeguzis/proton-pulse-web/wiki/Security-Guardrails)
wiki page.

Related repository:
[decky-proton-pulse](https://github.com/mdeguzis/decky-proton-pulse) (the
Steam Deck plugin that talks to the same Supabase backend) carries its own
`SECURITY.md` with the same policy.
