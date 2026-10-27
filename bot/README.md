# ClaimOne portal bot

Runs on the mini PC at a hospital. Every 30 minutes it reads claim status from payer portals; twice a day it downloads approval letters into the claim (a person still verifies them); every 15 minutes it can file pre-auths — **only for portal configs marked verified**.

## Safety model

- Signs in to ClaimOne as a normal user with role `bot` (create it in Supabase Auth + `clm_user_profiles`, scoped to this centre). It refuses to start if a service-role key is present.
- Changes claims only through `clm_bot_apply()`: three fields, and every status rule still applies.
- Screenshots stay on this machine (`./screenshots`, pruned after 7 days).
- One portal session at a time.

## Verifying a portal config (required before filing)

The URLs and selectors in `tpa-configs/*.json` were written without access to the live portals. For each payer:

1. Set `HEADLESS=false` in `.env`, run `node dist/scheduler.js --once --tpa=<code> --action=check_status` and watch.
2. Fix selectors until login, search and status extraction work; add every portal status text to `status_mapping`.
3. Repeat for `download_letter`, then `submit_preauth` on a test claim agreed with the payer.
4. Set `"verified_on": "YYYY-MM-DD"`.

Check each payer's provider agreement allows automated portal access before switching it on.

## Install

`sudo ./setup-elitedesk.sh`, then fill `.env` (see `.env.example`) and `sudo systemctl start claimone-bot`.
