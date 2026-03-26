# LinkedIn Referral Automator

A Chrome Extension (Manifest V3) that automates LinkedIn referral outreach — finds employees at target companies, sends personalised connection requests, and follows up with a referral message after they accept.

## What it does

| Stage | Action |
|---|---|
| **Cleanup** | Withdraws pending connection requests older than 30 days (runs automatically before each full run) |
| **Discover** | Searches LinkedIn for people at your target companies in your target roles |
| **Connect** | Sends connection requests with a personalised referral-ask note (≤ 300 chars) |
| **Message existing** | Sends referral messages directly to 1st-degree connections |
| **Follow-up** | Detects accepted connections and sends the referral message automatically |

## How it works

The extension runs entirely inside your browser using your existing LinkedIn session — no credentials stored, no external servers, no Selenium. All LinkedIn API calls are made from the LinkedIn tab itself (MAIN world injection) so cookies are automatically included.

State is persisted in `chrome.storage.local` across sessions. Each profile moves through a forward-only state machine:

```
discovered → connection_sent → message_sent
           ↘ message_sent  (if already 1st-degree at discovery)
           ↘ skipped       (rate limit / API error)
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

## Rate limits

LinkedIn enforces an informal limit of ~100 connection requests per week on free accounts, and ~20 custom-note connection requests per month.

| Setting | Default |
|---|---|
| Connections per run | 15 |
| Messages per run | 15 |
| Delay between actions | 4 000 ms ± 25 % jitter |
| Backoff on failures | 30 s → 60 s → 120 s → 300 s |

The extension tracks your monthly note count automatically and falls back to note-free connection requests when the quota is reached. If a note-with-note request returns 400, it retries once without the note before skipping.

## CAPTCHA / Challenge handling

If LinkedIn serves a challenge or CAPTCHA page during a run:

1. The run stops immediately
2. A red alert banner appears in the popup
3. A log entry is written: `CAPTCHA / challenge detected`

To recover: open `linkedin.com`, solve the challenge, then click any run button again.

## Pending invite cleanup

LinkedIn caps pending connection requests at ~700. Accounts that exceed this silently stop delivering new invites. The **Cleanup** stage (also runs automatically at the start of **Run All**) withdraws invitations older than 30 days to keep the queue healthy.

## Search fallback

People search uses `/search/dash/clusters` as the primary endpoint. If it returns a non-2xx response or zero results, the extension automatically falls back to the GraphQL `voyagerSearchDashClusters` endpoint.

LinkedIn's GraphQL `queryId` rotates with frontend deploys. If search stops working entirely, inspect the Network tab on a fresh LinkedIn search page, copy the new `queryId` from the URL, and update `SEARCH_FALLBACK_QUERY_ID` in `background/service-worker.js`.

## Extension fingerprinting protection

The manifest declares `"use_dynamic_url": true` on `web_accessible_resources`. This randomises extension asset URLs per session, preventing LinkedIn from probing for known extension file paths.

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

## Tech notes

- Uses LinkedIn's internal Voyager API (unofficial) — endpoints may change
- Messaging uses `voyagerMessagingDashMessengerMessages?action=createMessage` with `text/plain` content-type
- People search uses `search/dash/clusters` with normalized response format; falls back to GraphQL queryId endpoint
- Company URN resolution uses `organization/companies?q=universalName`
- All delays include ±25 % random jitter to avoid fixed-interval detection
- Monthly note quota tracked in `chrome.storage.local` under key `monthlyNotes`
