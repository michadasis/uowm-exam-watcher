# uowm-exam-watcher

Watches the CS department's exam-schedule page (`cs.uowm.gr`) for a newly
published/updated schedule document, extracts its text, and posts it (plus
the original file) to a Discord channel via webhook. Runs on a Vercel Cron
schedule.

## How it decides what's "new"

The department doesn't post exam schedules as blog announcements — they
maintain one static page,
[Πρόγραμμα Εξετάσεων](https://cs.uowm.gr/archiki-selida/programma-spoudwn/programma-exetaseon/),
where the **first** document link is always the current schedule; older
ones stay below it under a "Παλαιότερα Προγράμματα" separator.

Every run, the function fetches that page, reads whichever `.docx`/`.doc`/
`.pdf` link is currently first, and compares its URL against the one it
saw last time (stored in Upstash Redis under `uowm:exams-page:last-doc-url`).
If it's different, that's a new schedule: download it, extract the text
(via `mammoth` for .docx, `pdf-parse` for .pdf), and relay it to Discord.

## One-time setup

1. **Push this folder to a GitHub repo**, then import it in Vercel
   (New Project -> pick the repo). Framework preset: "Other".

2. **Add Upstash Redis**: in the Vercel project, Storage tab -> Create
   Database -> Upstash Redis (or connect an existing one). This
   auto-injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
   into the project's env vars — no separate signup needed.

3. **Create the Discord webhook**: in Discord, go to the target channel's
   Settings -> Integrations -> Webhooks -> New Webhook, copy the URL.
   Add it to Vercel's env vars as `DISCORD_WEBHOOK_URL`.

4. **(Recommended) Set `CRON_SECRET`**: any random string, added as an env
   var. Vercel automatically sends it as `Authorization: Bearer <value>`
   on cron-triggered requests, and the function rejects any request
   without it — stops randoms from hitting the endpoint and spamming
   your Discord channel.

5. Redeploy after adding env vars (Vercel only picks them up on a new
   deployment).

## Cron schedule

`vercel.json` currently runs once a day at 08:00 UTC:

```json
"schedule": "0 8 * * *"
```

- **Hobby plan**: limited to once-per-day cron jobs, and the exact
  trigger time can drift within an hour-ish window — fine for this use
  case, exam schedules don't need minute-level latency.
- **Pro plan**: can run much more often, e.g. every 6 hours:
  `"0 */6 * * *"`, or hourly: `"0 * * * *"`.

## Testing without spamming Discord

Hit the endpoint with `?dryRun=1` (and temporarily unset `CRON_SECRET`,
or pass the header yourself) to see what it *would* post, without
actually posting or marking anything as seen:

```
curl "https://<your-deployment>.vercel.app/api/check-exams?dryRun=1"
```

It returns JSON with the currently-detected document (`current`), what
was last stored (`lastSeen`), and whether they differ (`isNew`) — so you
can confirm detection looks right before letting it post for real.

## If the department changes how the page works

The one thing likely to need a tweak later: `fetchCurrentExamDoc()` in
`api/check-exams.js` assumes the schedule documents live inside a
`.entry-content` (or `article`) element as `<a href="....docx">` links,
newest first — standard WordPress page markup. If they restructure that
page (different layout, oldest-first ordering, etc.), adjust the selector
or ordering logic there.

## Timetable watcher

`api/check-timetable.js` watches the
[Ωρολόγιο Πρόγραμμα](https://cs.uowm.gr/archiki-selida/orologio-programma-mathimaton/)
page. It picks the newest document (highest `/uploads/YYYY/MM/` path, ties go
to the first link on the page), converts it to PDF by rendering the .docx
with `docx-preview` in headless Chromium (`@sparticuz/chromium`, free, no
LibreOffice needed), posts it to Discord in an embed with
the PDF attached, then pings the `Προσωρινή άδεια` and `Φοιτητές` roles. The last posted URL is
stored in Redis under `uowm:timetable-page:last-doc-url`.

Extra env var on Vercel:

- `TIMETABLE_WEBHOOK_URL`: webhook of the timetable channel

Testing:

- `/api/check-timetable?dryRun=1` shows what it detected, posts nothing
- `/api/check-timetable?preview=1` returns the converted PDF, posts nothing