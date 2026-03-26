# LinkedIn Referral Automator

A Chrome Extension (Manifest V3) that automates LinkedIn referral outreach — finds employees at target companies, sends personalised connection requests, and follows up with a referral message after they accept.

## What it does

| Stage | Action |
|---|---|
| **Cleanup** | Withdraws pending connection requests older than 30 days and checks your pending queue size |
| **Discover** | Searches LinkedIn for people at your target companies in your target roles |
| **Message existing** | Sends referral messages directly to 1st-degree connections |
| **Connect** | Sends connection requests with a personalised referral-ask note (≤ 300 chars) |
| **Follow-up** | Detects accepted connections, checks for existing replies, and sends the referral message |

## How it works

The extension runs entirely inside your browser using your existing LinkedIn session — no credentials stored, no external servers, no Selenium. All LinkedIn API calls are made from the LinkedIn tab itself (MAIN world injection) so cookies are automatically included.

State is persisted in `chrome.storage.local` across sessions. Each profile moves through a forward-only state machine:

```
discovered → connection_sent → message_sent
           ↘ message_sent  (if already 1st-degree at discovery)
           ↘ replied        (they responded — follow-up skipped)
           ↘ skipped        (rate limit / API error / max retries exceeded)
```

## Installation

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder
5. Open any LinkedIn tab
6. Click the extension icon

## Usage

1. **Targets** — add the companies and roles you want to target
2. **Templates** — customise your connection note and referral message
   - Placeholders: `{name}`, `{company}`, `{role}`
   - Connection note is capped at 300 characters (LinkedIn limit)
3. **Rate Limits** — set max connections/messages per run and delay between actions
4. **Run All** — runs all stages in sequence, or run each stage individually

> **Tip:** Run **Follow-up** daily. It checks which connections have been accepted and sends the referral message automatically.

## Buttons

| Button | Action |
|---|---|
| **Run All** | Cleanup → Discover → Message existing → Connect → Follow-up |
| **Discover** | Search for new profiles only |
| **Connect** | Send pending connection requests only |
| **Follow-up** | Message newly accepted connections only |
| **Cleanup** | Withdraw stale pending invites (>30 days) only |
| **Clear** | Wipe all stored profile data |

## Rate limits and safety

The extension applies multiple layered guards to stay within safe usage patterns.

### Per-run limits (configurable in popup)

| Setting | Default |
|---|---|
| Connections per run | 15 |
| Messages per run | 15 |
| Delay between actions | 15 000 ms, 50–150 % jitter |
| Backoff on failures | 30 s → 60 s → 120 s → 300 s |

### Daily rolling caps (across all runs in a 24-hour window)

| Setting | Default |
|---|---|
| Max connections per day | 20 |
| Max messages per day | 50 |

The daily counter resets at midnight. Clicking "Run All" multiple times in one day will be stopped by the daily cap once it is reached, regardless of the per-run limit.

### Account warming ramp

On a fresh installation the extension applies automatic per-run connection caps based on how long ago it was first run:

| Age | Effective cap |
|---|---|
| Days 1–7 | 5 connections / run |
| Days 8–14 | 10 connections / run |
| Day 15+ | Your configured value |

The ramp is logged at the start of Stage 3. It can be seen in the popup log.

### Pending invite guard

Stage 0 (Cleanup) reads your current pending invitation count and stores it. Stage 3 (Connect) checks this count against `maxPendingBeforeSkip` (default: 400). If the count meets or exceeds that threshold, Stage 3 is skipped for the run and a warning is logged.

The `400` default is intentionally conservative. Adjust it in the config if your account has a known higher tolerance. The extension makes no claims about what LinkedIn's internal limits actually are.

### Monthly note quota

LinkedIn limits custom-note connection requests per calendar month. The extension:

- Starts with a conservative default of **5 notes/month**
- Watches every 400 error response from the connect endpoint for a quota number in the response body
- Updates the stored cap automatically when one is detected
- Falls back to note-free connection requests when the quota is reached
- Retries once without a note if the first attempt returns 400

The detected cap persists in `chrome.storage.local` under `noteCapOverride`. To reset to the default, clear it from DevTools → Application → Storage.

## Checkpoint / resume after interruption

`Run All` saves a checkpoint to storage before executing each stage. If Chrome kills the service worker mid-run (common on long runs), the next `Run All` will:

1. Load the checkpoint
2. Log which stage it is resuming from
3. Skip already-completed stages
4. Continue from the interrupted stage

Each stage is safe to re-enter: already-processed profiles are filtered by their current status, so no duplicates are sent. The checkpoint is cleared on successful run completion.

## Reply detection

Before Stage 4 sends a follow-up message, it fetches the conversation with each pending contact and checks whether they have already replied. If a reply is detected:

- The profile status is set to `replied`
- The follow-up is skipped
- A log entry is written: `{name} already replied — marking replied, skipping follow-up`

Reply detection fails open: if the conversation API returns an error, the extension proceeds with the follow-up rather than silently blocking it.

## CAPTCHA / challenge handling

If LinkedIn serves a challenge or CAPTCHA page during a run:

1. The run stops immediately
2. A red alert banner appears in the popup
3. A log entry is written: `CAPTCHA / challenge detected`

To recover: open `linkedin.com`, solve the challenge, then click any run button again. The checkpoint ensures the run resumes from the stage that was interrupted.

## Search fallback

People search uses `/search/dash/clusters` as the primary endpoint. If it returns a non-2xx response or zero results, the extension automatically falls back to the GraphQL `voyagerSearchDashClusters` endpoint.

LinkedIn's GraphQL `queryId` rotates with frontend deploys. If search stops working entirely, inspect the Network tab on a fresh LinkedIn search page, copy the new `queryId` from the URL, and update `SEARCH_FALLBACK_QUERY_ID` in `background/service-worker.js`.

## Extension fingerprinting protection

The manifest declares `"use_dynamic_url": true` on `web_accessible_resources`. This randomises extension asset URLs per session, preventing LinkedIn from probing for known extension file paths.

---

## Functionality testing

Use this checklist after installing or updating the extension. Each test is independent — you do not need to run them in order.

### 1. Extension loads cleanly

- Open `chrome://extensions`
- Confirm "LinkedIn Referral Automator" appears with no error badge
- Click **Service Worker → Inspect** — console should show no errors on load
- Click the extension icon — popup should open without errors

### 2. Config saves correctly

- Add a company tag (e.g. "Stripe"), press Enter
- Open DevTools → Application → Storage → `chrome.storage.local`
- Confirm `config.companies` contains `"Stripe"`
- Remove the tag — confirm it is removed from storage on the next save

### 3. Discover stage hits the API

- Set one company and one role
- Click **Discover**
- Watch the popup log — you should see:
  - `"<Company>" → ID <number>` (company URN resolved)
  - `dash/clusters [...] → N people` or the GraphQL fallback equivalent
- Open DevTools → Network tab on the LinkedIn tab
- Confirm a request to `/voyager/api/search/dash/clusters` (or `/voyager/api/graphql`) appears with a `csrf-token` header
- After Discover completes, open storage and confirm `profiles` contains entries with `status: "discovered"`

### 4. No duplicate profiles

- Run **Discover** twice with the same config
- Check storage — each URN should appear exactly once
- The second run's log should show `0 new profiles discovered` (or a small number if new results were returned by LinkedIn)

### 5. Connection note length enforcement

- Set the connection note to exactly 300 characters — the counter in the popup should show `300/300` in black
- Type one more character — the counter should turn red and show `301/300`
- Run **Connect** with `maxConnectionsPerRun = 1`
- In the Network tab confirm the `customMessage` field in the POST body is exactly 300 characters (`.slice(0, 300)` applied)

### 6. Single connect test

- Set `maxConnectionsPerRun = 1` in the popup
- Click **Connect**
- Confirm the log shows `Connection sent to {name} ✓`
- In storage confirm the profile transitioned to `status: "connection_sent"` with `connection_sent_at` set to a valid ISO timestamp

### 7. Daily cap enforcement

- Set `maxDailyConnections = 1` temporarily (edit `DEFAULT_CONFIG` in `service-worker.js` or send a config update)
- Click **Connect** once — one connection should be sent
- Click **Connect** again — the log should show `Daily connection cap (1) reached` and send nothing
- Confirm `dailyActivity.connects` in storage equals 1

### 8. Account warming ramp

- Inspect `chrome.storage.local` for `firstRunDate`
- If it is within the first 7 days, run **Connect** with `maxConnectionsPerRun = 15`
- The log should show `Warming ramp: day N — cap 5` and stop after 5 sends
- To test day 15+ behaviour: temporarily set `firstRunDate` to a date 15+ days in the past via DevTools

### 9. Pending invite guard

- In DevTools, set `chrome.storage.local` key `_pendingInviteCount` manually to a number ≥ 400 (or run Cleanup on an account with many pending invites)
- Click **Run All** — Stage 3 log should show `Stage 3: skipped — N pending invites ≥ maxPendingBeforeSkip (400)`
- Stage 4 (Follow-up) should still run

### 10. Reply detection

- Find a profile in storage with `status: "connection_sent"` where you know the person has replied to a prior message
- Run **Follow-up**
- The log should show `{name} already replied — marking replied, skipping follow-up`
- In storage the profile should now have `status: "replied"` and `replied_at` set

### 11. Checkpoint / resume

- Start **Run All** — immediately close the LinkedIn tab before Stage 3 completes
- Open storage and confirm `_checkpoint` exists with a `stage` value of 3
- Re-open a LinkedIn tab and click **Run All** again
- The log should show `Resuming from checkpoint — starting at stage 3`
- Stages 0, 1, and 2 should be skipped; Stage 3 should resume (skipping already `connection_sent` profiles)
- After successful completion, confirm `_checkpoint` is removed from storage

### 12. CAPTCHA / challenge handling

- This is difficult to trigger on demand. If you see a red banner in the popup:
  1. Open `linkedin.com` and look for a challenge or CAPTCHA page
  2. Solve it
  3. Click any run button — the run should resume from the checkpoint

### 13. Monthly note quota fallback

- Set `noteCapOverride = 0` in storage via DevTools (simulates exhausted quota)
- Run **Connect**
- Log should show `Monthly note quota (0) reached — sending connects without note`
- Confirm the POST body in the Network tab has no `customMessage` field

### 14. Follow-up after acceptance

- Manually accept a connection request from a test account
- The profile should still be `status: "connection_sent"` in storage
- Run **Follow-up**
- Log should show `Follow-up sent to {name} ✓`
- Profile should transition to `status: "message_sent"` with `message_sent_at` set

### 15. Stale invite cleanup

- Run **Cleanup**
- Log should show `Stage 0: N pending invite(s) found`
- Any invites older than 30 days should show `Withdrew stale invite to {name} ✓`
- If none are older than 30 days: `Stage 0 complete — 0 stale invites withdrawn`

---

## Project structure

```
manifest.json              Extension config (MV3)
background/
  service-worker.js        All LinkedIn API calls, state machine, 5-stage pipeline
popup/
  popup.html               Extension UI
  popup.js                 Config read/write, log streaming, button handlers
content/
  content.js               DOM fallback for connect/message (used if API fails)
```

## Storage keys reference

| Key | Description |
|---|---|
| `config` | User configuration (companies, roles, templates, rate limits) |
| `profiles` | All discovered profiles and their current status |
| `monthlyNotes` | Monthly note send count and current month string |
| `noteCapOverride` | Detected or manually set monthly note cap |
| `dailyActivity` | Today's connect and message counts with date key |
| `firstRunDate` | ISO timestamp of the first ever run (used by warming ramp) |
| `_checkpoint` | Current stage checkpoint for interrupted RUN_ALL runs |

## Tech notes

- Uses LinkedIn's internal Voyager API (unofficial) — endpoints may change
- Messaging uses `voyagerMessagingDashMessengerMessages?action=createMessage` with `text/plain` content-type
- People search uses `search/dash/clusters` with normalized response format; falls back to GraphQL queryId endpoint
- Company URN resolution uses `organization/companies?q=universalName`
- All delays include 50–150 % random jitter to avoid fixed-interval detection
- Monthly note quota tracked in `chrome.storage.local` under `monthlyNotes`; actual cap learned from API error responses
