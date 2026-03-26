# LinkedIn Referral Automator

A Chrome Extension (Manifest V3) that automates LinkedIn referral outreach — finds employees at target companies, sends personalised connection requests, and follows up with a referral message after they accept.

## What it does

| Stage | Action |
|---|---|
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
4. **Run All** — runs all 4 stages in sequence, or run each stage individually

> **Tip:** Run **Follow-up** daily. It checks which connections have been accepted and sends the referral message automatically.

## Rate limits

LinkedIn enforces an informal limit of ~100 connection requests per week. Defaults are conservative:

| Setting | Default |
|---|---|
| Connections per run | 15 |
| Messages per run | 15 |
| Delay between actions | 4 000 ms |
| Backoff on failures | 30s → 60s → 120s → 300s |

## Project structure

```
manifest.json              Extension config (MV3)
background/
  service-worker.js        All LinkedIn API calls, state machine, 4-stage pipeline
popup/
  popup.html               Extension UI
  popup.js                 Config read/write, log streaming, button handlers
content/
  content.js               DOM fallback for connect/message (used if API fails)
```

## Tech notes

- Uses LinkedIn's internal Voyager API (unofficial) — endpoints may change
- Messaging uses `voyagerMessagingDashMessengerMessages?action=createMessage` with `text/plain` content-type
- People search uses `search/dash/clusters` with normalized response format
- Company URN resolution uses `organization/companies?q=universalName`
