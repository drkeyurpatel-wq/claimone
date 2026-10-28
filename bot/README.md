# ClaimOne portal bot

Runs on the mini PC at a hospital. It logs in to TPA websites with the hospital's own portal login and:

| Job | When | What staff see |
|---|---|---|
| Download payment statements | every morning, 9:20 | "Downloaded from TPA websites → Add" on **Upload payments**; staff press Save |
| Check claim status | every 30 min, 8 am–8 pm | claim status updates in ClaimOne |
| Download approval letters | 10 am and 4 pm | letter attached to the claim; a person verifies it |
| File pre-auths | every 15 min | **only after the portal config is marked verified** |

The payment statement job never writes to bills: it drops the file's rows in an inbox (`clm_bot_inbox`) and a person saves them. Status and letter jobs need the claim to exist in ClaimOne.

**Logins with an OTP or captcha:** the bot stops and records the run as blocked — it never guesses. Such portals need a person at the screen (or an OTP-relay, not built yet).

## Safety model

- Signs in to ClaimOne as a normal user with role `bot` (create it in Supabase Auth + `clm_user_profiles`, scoped to this centre). It refuses to start if a service-role key is present.
- Changes claims only through `clm_bot_apply()`: three fields, and every status rule still applies.
- Screenshots stay on this machine (`./screenshots`, pruned after 7 days).
- One portal session at a time.

## Verifying a portal config (required before filing)

The URLs and selectors in `tpa-configs/*.json` were written without access to the live portals. For each payer:

1. Set `HEADLESS=false` in `.env`, run `node dist/scheduler.js --once --tpa=<code> --action=download_payments` (then `check_status`) and watch.
2. Fix selectors until login, search and status extraction work; add every portal status text to `status_mapping`.
3. Repeat for `download_letter`, then `submit_preauth` on a test claim agreed with the payer.
4. Set `"verified_on": "YYYY-MM-DD"`.

Check each payer's provider agreement allows automated portal access before switching it on.

## Install

`sudo ./setup-elitedesk.sh`, then fill `.env` (see `.env.example`) and `sudo systemctl start claimone-bot`.
