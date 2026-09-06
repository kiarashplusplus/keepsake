# What's blocked on Kiarash

Five things need a human with dashboard access. Everything else in M0–M4 is built, tested and
running on preview. Do them in this order — each one unblocks the next round of verification.

Account: **Leapkg@gmail.com's Account**, id `dc6a87ed4a4269ed74c8f508b275b703`
Zone: **keepsake.ing**, id `dcc1fb09eeeba27a343fc1d98aff9094`
Preview Worker: **keepsake-preview** → <https://keepsake-preview.leapkg.workers.dev>
Production Worker (not deployed yet): **keepsake-production**

Paste anything you get back (site keys, tokens) into chat and I'll wire it up and verify.

---

## 1. Email Service — onboard `keepsake.ing` (~10 min, then DNS wait)

**Why first:** no Keepsake email has ever actually been delivered. Preview logs
`send_failed: could not find domain config of sending domain` on every send. Until this is done,
request notifications, email verification and dashboard recovery are code-complete but unproven,
and M3 stays at `[QA]`.

1. Cloudflare dashboard → left sidebar **Email** → **Email Service**.
   (If it's not in the sidebar, it's still in beta on this account — tell me and I'll switch the
   provider to Resend instead, which is a one-variable change we already built.)
2. **Sending** → **Add a sending domain** → enter `keepsake.ing`.
3. Cloudflare will offer to add the DKIM / SPF / DMARC records for you. Accept. Because
   keepsake.ing is already on Cloudflare DNS, this is a click, not a copy-paste.
4. Wait for the domain to show **Verified** (usually minutes).
5. You do **not** need to create a mailbox. We only send, from `hello@keepsake.ing`.

**Then tell me** and I'll run a real send on preview and read the result out of the
`email_events` table. Expected: `ok=1`, and an email in your inbox.

---

## 2. Turnstile — create the widget (~5 min)

**Why:** every public write (post a keepsake, ask for one, report one) is meant to be behind
Turnstile. Right now the middleware **soft-passes when no secret is set**, which is fine on
preview and must not be true in production.

1. Dashboard → **Turnstile** → **Add widget**.
2. Name: `keepsake`. Mode: **Managed**.
3. Hostnames — add all three:
   - `keepsake.ing`
   - `preview.keepsake.ing`
   - `keepsake-preview.leapkg.workers.dev`
4. Create. You'll get two values:
   - **Site key** — public, safe to paste in chat. Goes into the web build.
   - **Secret key** — treat as a password. Paste it in chat too (it only ever reaches the
     Worker as an encrypted secret), or run it yourself:
     ```
     cd ~/Documents/keepsake/apps/api
     npx wrangler secret put TURNSTILE_SECRET --env preview
     npx wrangler secret put TURNSTILE_SECRET --env production
     ```

**Then tell me** the site key and I'll rebuild preview with it and confirm a request without a
token is refused with `turnstile_failed`.

---

## 3. DNS — point `preview.keepsake.ing` at the preview Worker (~2 min)

**Why:** cosmetic but real — share links and Open Graph previews currently show the
`workers.dev` host. It also lets Turnstile's hostname list match.

1. Dashboard → **Workers & Pages** → **keepsake-preview** → **Settings** → **Domains & Routes**
   → **Add** → **Custom domain**.
2. Enter `preview.keepsake.ing`. Cloudflare creates the DNS record itself.

**Then tell me** and I'll flip `SITE_URL` back to `https://preview.keepsake.ing`, redeploy, and
re-check that an item link unfurls with the photo in iMessage.

---

## 4. GitHub Environments — let CI deploy on its own (~10 min)

**Why:** right now I deploy by hand from a local worktree. The `deploy.yml` workflow exists but
is gated off, so nothing ships automatically and there's no record of what shipped when.

1. Create the API token: dashboard → **My Profile** → **API Tokens** → **Create Token** →
   **Create Custom Token**. Permissions:
   | Scope | Resource | Level |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | Workers KV Storage | Edit |
   | Account | Workers R2 Storage | Edit |
   | Account | D1 | Edit |
   | Account | Account Settings | Read |
   | Zone | Workers Routes | Edit (zone: keepsake.ing) |
2. GitHub → `kiarashplusplus/keepsake` → **Settings** → **Environments** → **New environment**
   → `preview`. Repeat for `production`.
3. In **each** environment add:
   - Secret `CLOUDFLARE_API_TOKEN` = the token from step 1
   - Secret `CLOUDFLARE_ACCOUNT_ID` = `dc6a87ed4a4269ed74c8f508b275b703`
   - Variable `EXPO_PUBLIC_SITE_URL` = `https://preview.keepsake.ing` / `https://keepsake.ing`
   - Variable `EXPO_PUBLIC_TURNSTILE_SITE_KEY` = the site key from step 2
   - Variable `EXPO_PUBLIC_ENV` = `preview` / `production`
4. Repo **Settings → Secrets and variables → Actions → Variables** → add `DEPLOY_ENABLED` = `true`.
   This is the master switch; the deploy job is a no-op until it's set.

For production, consider adding yourself as a **required reviewer** on the `production`
environment so a merge to `main` can't ship without you clicking approve.

---

## 5. Production cutover — only when you're ready to be public

**Do not do this until 1–4 are done and you've used preview yourself.** Nothing is on
`keepsake.ing` today.

When you say go, I will:
1. Apply the migrations and load the postal-code table into the production database.
2. Set the production secrets (`TURNSTILE_SECRET`, `ADMIN_TOKEN`, optional `SENTRY_DSN`).
3. Deploy `keepsake-production` and check `/health` reports the exact commit.
4. Ask you to add the custom domain `keepsake.ing` (same clicks as step 3) — I can't create it.
5. Post the first real keepsake from your phone and watch it through moderation.

---

## What is *not* blocked on you

Already working on preview and verified against the live stack: give flow with real Workers AI
moderation, feed with search and postcode-radius, item pages with link previews, requests,
choosing a recipient, the admin queue, bans, and the nightly cleanup. The one thing I cannot
prove without step 1 is that an email actually arrives.
