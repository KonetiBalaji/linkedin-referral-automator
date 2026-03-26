'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const LI_BASE = 'https://www.linkedin.com';
const MAX_NOTE_LENGTH = 300;
const BACKOFF_DELAYS = [30000, 60000, 120000, 300000]; // ms — cap 300s
// Conservative starting cap; updated dynamically from API response bodies.
// LinkedIn's actual limit varies by account type and has changed over time — do not treat
// any hardcoded number here as ground truth.
const FREE_NOTE_MONTHLY_CAP_DEFAULT = 5;
// queryId rotates with LinkedIn frontend deploys. If search returns 400, inspect the Network
// tab on a fresh LinkedIn search and copy the new queryId from the URL.
const SEARCH_FALLBACK_QUERY_ID = 'voyagerSearchDashClusters.994bf4e7d2173b92ccdb5935710c3c5d';

const DEFAULT_CONFIG = {
  companies: ['OpenAI', 'Anthropic', 'Google', 'Microsoft', 'Databricks'],
  roles: ['AI Engineer', 'ML Engineer', 'Data Scientist', 'Applied Scientist', 'GenAI Engineer'],
  connectionNote:
    "Hi {name}, I'm exploring opportunities at {company} and came across your profile. " +
    "I'd love to connect — and if you're open to it, I'd really appreciate a referral for a {role} role. " +
    "Happy to share my resume. Thanks!",
  referralMessage:
    "Hi {name}, thanks for connecting! I've recently applied to {company} for a {role} position " +
    "and I'm really excited about the opportunity. Would you be open to referring me? " +
    "I'd be happy to send over my resume and a brief intro. Really appreciate any help — thanks so much!",
  maxConnectionsPerRun: 15,
  maxMessagesPerRun: 15,
  actionDelayMs: 15000,      // 15 s default — more human-like pacing (was 4 s)
  maxDailyConnections: 20,   // rolling 24-hour cap across all runs
  maxDailyMessages: 50,
  maxPendingBeforeSkip: 400, // skip Stage 3 if pending invite count reaches this; no claim about LinkedIn's internal limit
};

let popupPort = null;
let consecutiveFailures = 0;
let isRunning = false;
let _halted = false;          // set true on CAPTCHA/challenge detection — cleared on next run start
let _pendingInviteCount = null; // set by Stage 0, read by Stage 3

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log('[LRA]', msg);
  if (popupPort) {
    try { popupPort.postMessage({ type: 'LOG', message: msg }); } catch (_) {}
  }
}

// ─── LinkedIn tab helper ──────────────────────────────────────────────────────

async function getLinkedInTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (!tabs.length) throw new Error('No LinkedIn tab open — please open linkedin.com first');
  return tabs[0].id;
}

// ─── API calls via page context (MAIN world) ──────────────────────────────────
// Service worker fetch() does NOT carry LinkedIn cookies (cross-origin extension context).
// Injecting into the LinkedIn tab's MAIN world means live cookies are automatic.
// Returns: { status: number, data: object|null, isChallenge: boolean }

async function apiCall(path, postBody = null, method = null) {
  const tabId = await getLinkedInTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (path, postBody, method) => {
      const csrfCookie = document.cookie.split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('JSESSIONID='));
      const csrf = csrfCookie
        ? csrfCookie.split('=').slice(1).join('=').replace(/"/g, '')
        : '';

      const init = {
        credentials: 'include',
        headers: {
          'csrf-token': csrf,
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'x-restli-protocol-version': '2.0.0',
        },
      };
      if (postBody !== null) {
        init.method = 'POST';
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(postBody);
      } else if (method) {
        init.method = method;
      }

      try {
        const res = await fetch(`https://www.linkedin.com${path}`, init);
        // Challenge detection: status 999 or redirect to /checkpoint/ or /challenge/
        let isChallenge = res.status === 999
          || res.url.includes('/checkpoint/')
          || res.url.includes('/challenge/');
        let data = null;
        try {
          data = await res.json();
          if (!isChallenge && data) {
            const s = JSON.stringify(data).toLowerCase();
            if (s.includes('captcha') || (s.includes('"challenge"') && s.includes('"url"'))) {
              isChallenge = true;
            }
          }
        } catch (_) { /* non-JSON response — isChallenge already set from URL/status check */ }
        return { status: res.status, data, isChallenge };
      } catch (e) {
        return { status: 0, data: null, isChallenge: false, error: e.message };
      }
    },
    args: [path, postBody, method],
  });
  return results?.[0]?.result ?? { status: 0, data: null, isChallenge: false };
}

const ok   = r => r.status >= 200 && r.status < 300;
const get  = path         => apiCall(path, null);
const post = (path, body) => apiCall(path, body);

// LinkedIn's new messaging endpoints require text/plain content-type (not application/json).
// postText wraps apiCall with that override injected at the page level.
async function postText(path, body) {
  const tabId = await getLinkedInTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (path, body) => {
      const csrfCookie = document.cookie.split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('JSESSIONID='));
      const csrf = csrfCookie
        ? csrfCookie.split('=').slice(1).join('=').replace(/"/g, '')
        : '';
      try {
        const res = await fetch(`https://www.linkedin.com${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'csrf-token': csrf,
            'accept': 'application/json',
            'content-type': 'text/plain;charset=UTF-8',
            'x-restli-protocol-version': '2.0.0',
          },
          body: JSON.stringify(body),
        });
        let isChallenge = res.status === 999
          || res.url.includes('/checkpoint/')
          || res.url.includes('/challenge/');
        let data = null;
        try {
          data = await res.json();
          if (!isChallenge && data) {
            const s = JSON.stringify(data).toLowerCase();
            if (s.includes('captcha') || (s.includes('"challenge"') && s.includes('"url"'))) {
              isChallenge = true;
            }
          }
        } catch (_) {}
        return { status: res.status, data, isChallenge };
      } catch (e) {
        return { status: 0, data: null, isChallenge: false, error: e.message };
      }
    },
    args: [path, body],
  });
  return results?.[0]?.result ?? { status: 0, data: null, isChallenge: false };
}

// ─── Storage ──────────────────────────────────────────────────────────────────

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  const saved = config || {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    companies: (saved.companies && saved.companies.length) ? saved.companies : DEFAULT_CONFIG.companies,
    roles: (saved.roles && saved.roles.length) ? saved.roles : DEFAULT_CONFIG.roles,
  };
}

async function getProfiles() {
  const { profiles } = await chrome.storage.local.get('profiles');
  return profiles || {};
}

async function saveProfiles(profiles) {
  await chrome.storage.local.set({ profiles });
}

async function updateProfile(urn, updates) {
  const profiles = await getProfiles();
  profiles[urn] = { ...(profiles[urn] || {}), ...updates };
  await saveProfiles(profiles);
}

// ─── Pipeline checkpoint (resume after SW kill) ───────────────────────────────
// RUN_ALL saves which stage it is about to execute. If Chrome kills the service
// worker mid-run, the next RUN_ALL start resumes from that stage rather than
// restarting from Stage 0. Cleared on successful run completion.

async function saveCheckpoint(stage) {
  await chrome.storage.local.set({ _checkpoint: { stage, savedAt: new Date().toISOString() } });
}
async function loadCheckpoint() {
  const { _checkpoint } = await chrome.storage.local.get('_checkpoint');
  return _checkpoint || null;
}
async function clearCheckpoint() {
  await chrome.storage.local.remove('_checkpoint');
}

// ─── Daily action counter ─────────────────────────────────────────────────────
// Tracks connects and messages sent today (YYYY-MM-DD). Resets at midnight.
// Prevents multiple back-to-back runs from exceeding safe daily totals.

async function getDailyActivity() {
  const { dailyActivity } = await chrome.storage.local.get('dailyActivity');
  const today = new Date().toISOString().slice(0, 10);
  if (!dailyActivity || dailyActivity.date !== today) {
    return { date: today, connects: 0, messages: 0 };
  }
  return dailyActivity;
}

async function incrementDailyActivity(type) {
  const activity = await getDailyActivity();
  activity[type] = (activity[type] || 0) + 1;
  await chrome.storage.local.set({ dailyActivity: activity });
  return activity;
}

// ─── Account warming ramp ─────────────────────────────────────────────────────
// Caps connections per run based on days since first run. Useful for accounts
// that are new to automation. Ramp: ≤7 days→5, ≤14 days→10, 15+→configured value.
// firstRunDate is set once and never overwritten.

async function getEffectiveConnectionCap(config) {
  const { firstRunDate } = await chrome.storage.local.get('firstRunDate');
  if (!firstRunDate) {
    await chrome.storage.local.set({ firstRunDate: new Date().toISOString() });
    log('Warming ramp: first run recorded — capping at 5 connects today');
    return Math.min(config.maxConnectionsPerRun, 5);
  }
  const ageDays = Math.floor((Date.now() - new Date(firstRunDate).getTime()) / 86400000);
  if (ageDays < 7)  { log(`Warming ramp: day ${ageDays} — cap 5`);  return Math.min(config.maxConnectionsPerRun, 5);  }
  if (ageDays < 14) { log(`Warming ramp: day ${ageDays} — cap 10`); return Math.min(config.maxConnectionsPerRun, 10); }
  return config.maxConnectionsPerRun;
}

// ─── Monthly note quota tracking ──────────────────────────────────────────────
// LinkedIn caps custom-note connection requests per calendar month.
// The actual limit varies by account type and has changed over time — we start
// with a conservative default (FREE_NOTE_MONTHLY_CAP_DEFAULT) and update the
// stored cap from API response bodies when they surface a quota number.

async function getNoteCap() {
  const { noteCapOverride } = await chrome.storage.local.get('noteCapOverride');
  return noteCapOverride ?? FREE_NOTE_MONTHLY_CAP_DEFAULT;
}

// Call after a connect-with-note returns 400 — parses the error body for an
// explicit monthly quota number and persists it if one is found.
async function tryUpdateNoteCapFromError(responseData) {
  if (!responseData) return;
  const body = JSON.stringify(responseData);
  const match = body.match(/monthly[^"]{0,40}?(\d+)/i)
             || body.match(/quota[^"]{0,40}?(\d+)/i)
             || body.match(/limit[^"]{0,40}?(\d+)/i);
  if (match) {
    const detected = parseInt(match[1], 10);
    if (detected > 0 && detected <= 100) {
      log(`Note quota detected from API: ${detected}/month — updating stored cap`);
      await chrome.storage.local.set({ noteCapOverride: detected });
    }
  }
}

async function getMonthlyNoteState() {
  const { monthlyNotes } = await chrome.storage.local.get('monthlyNotes');
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
  if (!monthlyNotes || monthlyNotes.month !== thisMonth) {
    return { month: thisMonth, sent: 0 };
  }
  return monthlyNotes;
}

async function incrementMonthlyNoteCount() {
  const state = await getMonthlyNoteState();
  state.sent++;
  await chrome.storage.local.set({ monthlyNotes: state });
  return state.sent;
}

// ─── Delay & backoff ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 50–150 % of actionDelayMs — wider window gives a more human-like timing distribution.
async function withDelay(config) {
  const jitter = config.actionDelayMs * (0.5 + Math.random() * 1.0);
  await sleep(Math.round(jitter));
}

async function handleFailure(label) {
  consecutiveFailures++;
  const wait = BACKOFF_DELAYS[Math.min(consecutiveFailures - 1, BACKOFF_DELAYS.length - 1)];
  log(`${label} — failure #${consecutiveFailures}, backing off ${wait / 1000}s`);
  await sleep(wait);
}

function resetFailures() {
  consecutiveFailures = 0;
}

// ─── Challenge / CAPTCHA detection ───────────────────────────────────────────

function haltOnChallenge(context) {
  _halted = true;
  log(`CAPTCHA / challenge detected during ${context} — run halted. Solve the challenge on linkedin.com then try again.`);
  if (popupPort) {
    try { popupPort.postMessage({ type: 'CAPTCHA_DETECTED' }); } catch (_e) {}
  }
}

// ─── My URN (sender identity) ─────────────────────────────────────────────────

let _myUrn = null;

async function getMyUrn() {
  if (_myUrn) return _myUrn;
  const r = await get('/voyager/api/me');
  if (!ok(r) || !r.data) { log(`getMyUrn: /me returned ${r.status}`); return null; }
  let urn = r.data?.data?.entityUrn || null;
  if (!urn) {
    for (const item of (r.data?.included || [])) {
      if (item?.entityUrn?.includes('fsd_profile') || item?.entityUrn?.includes('miniProfile')) {
        urn = item.entityUrn; break;
      }
    }
  }
  if (urn && !urn.includes('fsd_profile')) {
    urn = urn.replace(/urn:li:\w+:/, 'urn:li:fsd_profile:');
  }
  _myUrn = urn;
  log(`getMyUrn: ${_myUrn}`);
  return _myUrn;
}

// ─── Messaging (new Dash endpoint) ────────────────────────────────────────────
// Endpoint: POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
// Content-Type: text/plain;charset=UTF-8
// Requires: mailboxUrn (own fsd_profile URN) + conversationUrn (from lookup)

async function getConversationUrn(recipientUrn, myUrn) {
  const r = await get(
    `/voyager/api/voyagerMessagingDashMessengerConversations` +
    `?q=participants&recipients=List(${encodeURIComponent(recipientUrn)})` +
    `&mailboxUrn=${encodeURIComponent(myUrn)}`
  );
  if (!ok(r) || !r.data) return null;

  const elements = r.data?.data?.elements || r.data?.elements || [];
  if (elements.length > 0) {
    const urn = elements[0]?.entityUrn || elements[0]?.conversationUrn;
    if (urn) return urn;
  }
  for (const item of (r.data?.included || [])) {
    const urn = item?.entityUrn || '';
    if (urn.includes('msg_conversation')) return urn;
  }
  return null;
}

async function sendMessageDash(recipientUrn, text, myUrn) {
  let convUrn = await getConversationUrn(recipientUrn, myUrn);
  log(`sendMessageDash convUrn: ${convUrn}`);

  if (convUrn) {
    return postText('/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
      dedupeByClientGeneratedToken: false,
      mailboxUrn: myUrn,
      message: {
        body: { attributes: [], text },
        conversationUrn: convUrn,
        originToken: crypto.randomUUID(),
        renderContentUnions: [],
      },
    });
  }

  // No existing conversation — LinkedIn auto-creates on first message
  const r = await postText('/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
    dedupeByClientGeneratedToken: false,
    mailboxUrn: myUrn,
    recipients: [recipientUrn],
    message: {
      body: { attributes: [], text },
      originToken: crypto.randomUUID(),
      renderContentUnions: [],
    },
  });
  log(`sendMessageDash (new conversation) → ${r.status}`);
  return r;
}

function fillTemplate(template, profile) {
  return template
    .replace(/\{name\}/g, profile.name || '')
    .replace(/\{company\}/g, profile.company || '')
    .replace(/\{role\}/g, profile.role || '');
}

// ─── Status update → popup ────────────────────────────────────────────────────

async function sendStatusUpdate() {
  const profiles = await getProfiles();
  const counts = { discovered: 0, connection_sent: 0, connected: 0, message_sent: 0, skipped: 0 };
  for (const p of Object.values(profiles)) {
    if (p.status in counts) counts[p.status]++;
  }
  if (popupPort) {
    try { popupPort.postMessage({ type: 'STATUS_UPDATE', counts }); } catch (_) {}
  }
}

// ─── Stage 0: Pending Invite Cleanup ──────────────────────────────────────────
// Withdraw connection requests older than 30 days to stay well below the ~700 pending cap
// and maintain a healthy acceptance rate (low rate triggers stricter weekly limits).

async function stagePendingCleanup(config) {
  if (_halted) { log('Stage 0: halted — skipping'); return; }
  log('Stage 0: Pending invite cleanup — starting');

  const r = await get(
    '/voyager/api/relationships/sentInvitations?q=all&start=0&count=100&invitationType=CONNECTION'
  );
  if (r.isChallenge) { haltOnChallenge('pendingCleanup'); return; }
  if (!ok(r) || !r.data) {
    log(`Pending cleanup: could not fetch sent invitations (${r.status}) — skipping`);
    return;
  }

  const elements = r.data?.elements || r.data?.data?.elements || [];
  _pendingInviteCount = elements.length;
  log(`Stage 0: ${elements.length} pending invite(s) found`);
  if (config.maxPendingBeforeSkip && elements.length >= config.maxPendingBeforeSkip) {
    log(`Pending count (${elements.length}) ≥ maxPendingBeforeSkip (${config.maxPendingBeforeSkip}) — Stage 3 will be skipped this run`);
  }

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  let withdrawn = 0;
  for (const inv of elements) {
    if (_halted) break;

    // sentTime is epoch-ms in most Voyager responses; fall back to createdAt
    const sentAt = inv.sentTime ?? inv.createdAt ?? null;
    if (!sentAt || sentAt > cutoffMs) continue;

    // entityUrn shape: urn:li:fs_sentInvitation:12345  →  id = "12345"
    const invId = inv.entityUrn?.split(':').pop();
    if (!invId) continue;

    const firstName = inv.toMember?.firstName || invId;
    // Withdrawal: POST with ?action=withdraw (confirmed by linkedin-private-api)
    const dr = await post(
      `/voyager/api/relationships/invitations/${invId}?action=withdraw`,
      {}
    );
    if (dr.isChallenge) { haltOnChallenge('invite withdrawal'); break; }
    if (ok(dr)) {
      withdrawn++;
      log(`Withdrew stale invite to ${firstName} ✓`);
    } else {
      log(`Withdraw ${invId} failed (${dr.status}) — skipping`);
    }
    await withDelay(config);
  }

  log(`Stage 0 complete — ${withdrawn} stale invites withdrawn`);
  sendStatusUpdate();
}

// ─── Stage 1: Discover ────────────────────────────────────────────────────────

function companyNameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

async function resolveCompanyUrn(companyName) {
  try {
    const slug = companyNameToSlug(companyName);
    const r = await get(`/voyager/api/organization/companies?q=universalName&universalName=${encodeURIComponent(slug)}`);
    log(`universalName "${slug}" → ${r.status}`);
    if (r.isChallenge) { haltOnChallenge('resolveCompanyUrn'); return null; }
    if (ok(r) && r.data) {
      const elements = r.data?.data?.['*elements'] || [];
      if (elements.length > 0) {
        const id = elements[0].split(':').pop();
        if (id) return id;
      }
      log(`universalName unexpected shape: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
  } catch (e) {
    log(`universalName lookup error for "${companyName}": ${e.message}`);
  }
  log(`Could not resolve company ID for "${companyName}" — skipping`);
  return null;
}

// Primary search: /search/dash/clusters (confirmed working).
// Falls back to GraphQL queryId endpoint if primary returns non-2xx or zero results.
async function searchPeople(companyId, role, start = 0) {
  const keywords = encodeURIComponent(role);
  const r = await get(
    `/voyager/api/search/dash/clusters?q=all` +
    `&query=(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:(currentCompany:List(${companyId}),resultType:List(PEOPLE)))` +
    `&start=${start}&count=20`
  );

  if (r.isChallenge) { haltOnChallenge('searchPeople'); return []; }

  if (!ok(r) || !r.data) {
    log(`dash/clusters [${role}@${companyId}] → ${r.status} — trying GraphQL fallback`);
    return searchPeopleGraphQL(companyId, role, start);
  }

  const byUrn = {};
  for (const item of (r.data?.included || [])) {
    if (item?.entityUrn) byUrn[item.entityUrn] = item;
  }

  const people = [];
  for (const cluster of (r.data?.data?.elements || [])) {
    for (const searchItem of (cluster?.items || [])) {
      const entityResultUrn = searchItem?.itemUnion?.['*entityResult'];
      if (!entityResultUrn) continue;
      const profileMatch = entityResultUrn.match(/(urn:li:fsd_profile:[^,)]+)/);
      if (!profileMatch) continue;
      const profileUrn = profileMatch[1];
      const entity = byUrn[entityResultUrn];
      const name = entity?.title?.text;
      if (!name) continue;
      const distance = entity?.entityCustomTrackingInfo?.memberDistance ?? null;
      const navUrl = entity?.navigationUrl || '';
      const navMatch = navUrl.match(/\/in\/([^/?]+)/);
      people.push({ urn: profileUrn, name, distance, public_id: navMatch ? navMatch[1] : null });
    }
  }

  // Zero results on page 0 may indicate the endpoint shifted — try GraphQL fallback once
  if (people.length === 0 && start === 0) {
    log(`dash/clusters returned 0 results for [${role}@${companyId}] — trying GraphQL fallback`);
    return searchPeopleGraphQL(companyId, role, start);
  }

  log(`dash/clusters [${role}@${companyId}] start=${start} → ${people.length} people`);
  return people;
}

// Fallback search: /voyager/api/graphql with queryId.
// SEARCH_FALLBACK_QUERY_ID rotates with LinkedIn deploys — if this 400s, inspect the Network
// tab on a fresh LinkedIn search page for the current queryId.
async function searchPeopleGraphQL(companyId, role, start = 0) {
  const variablesRaw =
    `(start:${start},count:20,origin:FACETED_SEARCH,` +
    `query:(flagshipSearchIntent:SEARCH_SRP,` +
    `queryParameters:List(` +
    `(key:currentCompany,value:List(${companyId})),` +
    `(key:resultType,value:List(PEOPLE)),` +
    `(key:title,value:List(${role}))),` +
    `includeFiltersInResponse:false))`;

  const r = await get(
    `/voyager/api/graphql?variables=${encodeURIComponent(variablesRaw)}&queryId=${SEARCH_FALLBACK_QUERY_ID}`
  );

  if (r.isChallenge) { haltOnChallenge('searchPeopleGraphQL'); return []; }
  if (!ok(r) || !r.data) {
    log(`GraphQL fallback [${role}@${companyId}] → ${r.status} — both search endpoints failed`);
    return [];
  }

  // GraphQL response: data.searchDashClustersByAll.elements[].items[].item.entityResult
  const clusters = r.data?.data?.searchDashClustersByAll?.elements || [];
  const people = [];

  for (const cluster of clusters) {
    for (const hit of (cluster?.items || [])) {
      const entity = hit?.item?.entityResult;
      if (!entity) continue;
      // Use targetUrn (stable profile URN) over trackingUrn (obfuscated, session-specific)
      const profileUrn = entity.targetUrn || entity.trackingUrn;
      if (!profileUrn || !profileUrn.includes('fsd_profile')) continue;
      const name = entity.title?.text;
      if (!name) continue;
      const distance = entity.memberDistance?.value ?? null;
      const navUrl = entity.navigationUrl || '';
      const navMatch = navUrl.match(/\/in\/([^/?]+)/);
      people.push({ urn: profileUrn, name, distance, public_id: navMatch ? navMatch[1] : null });
    }
  }

  log(`GraphQL fallback [${role}@${companyId}] start=${start} → ${people.length} people`);
  return people;
}

async function stageDiscover(config) {
  if (_halted) { log('Stage 1: halted — skipping'); return; }
  log('Stage 1: Discover — starting');
  const profiles = await getProfiles();
  let newCount = 0;

  for (const company of config.companies) {
    if (_halted) break;
    const companyId = await resolveCompanyUrn(company);
    if (!companyId) continue;
    log(`"${company}" → ID ${companyId}`);

    for (const role of config.roles) {
      if (_halted) break;
      let start = 0;
      for (let page = 0; page < 5; page++) {
        if (_halted) break;
        const people = await searchPeople(companyId, role, start);
        if (people.length === 0) break;
        for (const p of people) {
          if (!profiles[p.urn]) {
            profiles[p.urn] = {
              name: p.name, company, role,
              public_id: p.public_id,
              distance: p.distance,
              status: 'discovered',
              discovered_at: new Date().toISOString(),
              connection_sent_at: null,
              message_sent_at: null,
            };
            newCount++;
          }
        }
        await saveProfiles(profiles);
        await withDelay(config);
        start += 20;
      }
    }
  }

  log(`Stage 1 complete — ${newCount} new profiles discovered`);
  sendStatusUpdate();
}

// ─── Stage 2: Message Existing Connections (DISTANCE_1) ───────────────────────

async function stageMessageExisting(config) {
  if (_halted) { log('Stage 2: halted — skipping'); return; }
  log('Stage 2: Message existing connections — starting');
  const myUrn = await getMyUrn();
  if (!myUrn) { log('Stage 2: could not resolve own URN — aborting'); return; }
  const profiles = await getProfiles();
  let sent = 0;

  for (const [urn, p] of Object.entries(profiles)) {
    if (_halted) break;
    if (sent >= config.maxMessagesPerRun) { log('Max messages/run reached'); break; }
    if (p.status !== 'discovered') continue;
    if (p.distance !== 'DISTANCE_1' && p.distance !== 1) continue;

    const daily2 = await getDailyActivity();
    if (daily2.messages >= config.maxDailyMessages) { log(`Daily message cap (${config.maxDailyMessages}) reached`); break; }

    try {
      const r = await sendMessageDash(urn, fillTemplate(config.referralMessage, p), myUrn);
      if (r.isChallenge) { haltOnChallenge(`message to ${p.name}`); break; }
      if (ok(r)) {
        await updateProfile(urn, { status: 'message_sent', message_sent_at: new Date().toISOString() });
        await incrementDailyActivity('messages');
        log(`Messaged ${p.name} ✓`);
        sent++;
        resetFailures();
      } else {
        log(`Message failed for ${p.name} — ${r.status} | ${JSON.stringify(r.data || {}).slice(0, 150)}`);
        await handleFailure(`Message to ${p.name}`);
        await updateProfile(urn, { status: 'skipped' });
      }
    } catch (e) {
      log(`Message error for ${p.name}: ${e.message}`);
      await updateProfile(urn, { status: 'skipped' });
    }
    await withDelay(config);
  }

  log(`Stage 2 complete — ${sent} messages sent`);
  sendStatusUpdate();
}

// ─── Stage 3: Send Connection Requests (DISTANCE_2/3) ────────────────────────

async function stageConnectNew(config) {
  if (_halted) { log('Stage 3: halted — skipping'); return; }
  log('Stage 3: Send connection requests — starting');

  // Pending invite guard — skip stage if Stage 0 found count at or above threshold
  if (_pendingInviteCount !== null && config.maxPendingBeforeSkip
      && _pendingInviteCount >= config.maxPendingBeforeSkip) {
    log(`Stage 3: skipped — ${_pendingInviteCount} pending invites ≥ maxPendingBeforeSkip (${config.maxPendingBeforeSkip})`);
    return;
  }

  const effectiveCap = await getEffectiveConnectionCap(config);
  if (effectiveCap < config.maxConnectionsPerRun) {
    log(`Stage 3: warming ramp reduced cap to ${effectiveCap}`);
  }

  const profiles = await getProfiles();
  let sent = 0;
  let noteQuotaLogShown = false;

  for (const [urn, p] of Object.entries(profiles)) {
    if (_halted) break;
    if (sent >= effectiveCap) { log('Max connections/run reached'); break; }
    if (p.status !== 'discovered') continue;
    if (p.distance === 'DISTANCE_1' || p.distance === 1) continue;

    const daily3 = await getDailyActivity();
    if (daily3.connects >= config.maxDailyConnections) { log(`Daily connection cap (${config.maxDailyConnections}) reached`); break; }

    // Adaptive note strategy: use dynamic cap; fall back to note-free when exhausted
    const noteState = await getMonthlyNoteState();
    const noteCap = await getNoteCap();
    const useNote = noteState.sent < noteCap;
    if (!useNote && !noteQuotaLogShown) {
      log(`Monthly note quota (${noteCap}) reached — sending connects without note`);
      noteQuotaLogShown = true;
    }

    const body = { invitee: { inviteeUnion: { memberProfile: urn } } };
    if (useNote) body.customMessage = fillTemplate(config.connectionNote, p).slice(0, MAX_NOTE_LENGTH);

    try {
      const r = await post(
        '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
        body
      );

      if (r.isChallenge) { haltOnChallenge(`connect to ${p.name}`); break; }

      if (r.status === 201 || r.status === 200) {
        if (useNote) await incrementMonthlyNoteCount();
        await updateProfile(urn, { status: 'connection_sent', connection_sent_at: new Date().toISOString() });
        await incrementDailyActivity('connects');
        log(`Connection sent to ${p.name} ✓${useNote ? '' : ' (no note)'} (${r.status})`);
        sent++;
        resetFailures();
      } else if (r.status === 429) {
        const body429 = JSON.stringify(r.data || {});
        if (body429.includes('WEEKLY_LIMIT') || body429.includes('invitationsSentInLast7Days')) {
          log('Weekly connection limit hit — stopping');
          break;
        }
        await handleFailure(`429 on connect to ${p.name}`);
      } else if (r.status === 400) {
        if (useNote) {
          await tryUpdateNoteCapFromError(r.data); // learn actual quota from error body if present
          // 400 may indicate note was rejected (quota exceeded on LinkedIn's side) — retry without
          log(`Connect 400 for ${p.name} — retrying without note`);
          const rNoNote = await post(
            '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
            { invitee: { inviteeUnion: { memberProfile: urn } } }
          );
          if (rNoNote.isChallenge) { haltOnChallenge(`connect retry to ${p.name}`); break; }
          if (rNoNote.status === 201 || rNoNote.status === 200) {
            await updateProfile(urn, { status: 'connection_sent', connection_sent_at: new Date().toISOString() });
            await incrementDailyActivity('connects');
            log(`Connection sent to ${p.name} ✓ (no note, retry) (${rNoNote.status})`);
            sent++;
            resetFailures();
          } else {
            log(`${p.name} still failed without note (${rNoNote.status}) — skipping`);
            await updateProfile(urn, { status: 'skipped' });
          }
        } else {
          log(`${p.name} already connected or pending — skipping`);
          await updateProfile(urn, { status: 'skipped' });
        }
      } else {
        log(`Connect failed for ${p.name} — ${r.status} | ${JSON.stringify(r.data).slice(0, 200)}`);
        await handleFailure(`Connect to ${p.name}`);
      }
    } catch (e) {
      log(`Connect error for ${p.name}: ${e.message}`);
    }
    await withDelay(config);
  }

  log(`Stage 3 complete — ${sent} connection requests sent`);
  sendStatusUpdate();
}

// ─── Reply detection ──────────────────────────────────────────────────────────
// Returns true if the conversation with recipientUrn contains at least one message
// sent by the other party (i.e. they replied to us). Fails open — returns false
// on any error so a detection failure never silently blocks a follow-up.

async function hasReply(recipientUrn, myUrn) {
  try {
    const cr = await get(
      `/voyager/api/voyagerMessagingDashMessengerConversations` +
      `?q=participants&recipients=List(${encodeURIComponent(recipientUrn)})` +
      `&mailboxUrn=${encodeURIComponent(myUrn)}`
    );
    if (!ok(cr) || !cr.data) return false;

    const elements = cr.data?.data?.elements || cr.data?.elements || [];
    if (!elements.length) return false;

    const convUrn = elements[0]?.entityUrn || elements[0]?.conversationUrn;
    if (!convUrn) return false;

    const mr = await get(
      `/voyager/api/voyagerMessagingDashMessengerMessages` +
      `?q=conversation&conversationUrn=${encodeURIComponent(convUrn)}&count=5`
    );
    if (!ok(mr) || !mr.data) return false;

    const messages = mr.data?.data?.elements || mr.data?.elements || [];
    const myId = myUrn.split(':').pop();
    return messages.some(msg => {
      const senderUrn = msg?.sender?.entityUrn || msg?.senderUrn || '';
      return senderUrn && senderUrn.split(':').pop() !== myId;
    });
  } catch (_) {
    return false; // fail open
  }
}

// ─── Stage 4: Follow-up After Acceptance ─────────────────────────────────────

async function stageFollowUp(config) {
  if (_halted) { log('Stage 4: halted — skipping'); return; }
  log('Stage 4: Follow-up on accepted connections — starting');
  const myUrn = await getMyUrn();
  if (!myUrn) { log('Stage 4: could not resolve own URN — aborting'); return; }
  const profiles = await getProfiles();
  let sent = 0;

  for (const [urn, p] of Object.entries(profiles)) {
    if (_halted) break;
    if (sent >= config.maxMessagesPerRun) { log('Max messages/run reached'); break; }
    if (p.status !== 'connection_sent') continue;

    const daily4 = await getDailyActivity();
    if (daily4.messages >= config.maxDailyMessages) { log(`Daily message cap (${config.maxDailyMessages}) reached`); break; }

    try {
      // Skip follow-up if they already replied to a prior message
      const replied = await hasReply(urn, myUrn);
      if (replied) {
        await updateProfile(urn, { status: 'replied', replied_at: new Date().toISOString() });
        log(`${p.name} already replied — marking replied, skipping follow-up`);
        await withDelay(config);
        continue;
      }

      const msgR = await sendMessageDash(urn, fillTemplate(config.referralMessage, p), myUrn);
      if (msgR.isChallenge) { haltOnChallenge(`follow-up to ${p.name}`); break; }
      log(`follow-up ${p.name} → ${msgR.status} | ${JSON.stringify(msgR.data || {}).slice(0, 150)}`);
      if (ok(msgR)) {
        await updateProfile(urn, { status: 'message_sent', message_sent_at: new Date().toISOString() });
        await incrementDailyActivity('messages');
        log(`Follow-up sent to ${p.name} ✓`);
        sent++;
        resetFailures();
      } else if (msgR.status === 403 || msgR.status === 422 || msgR.status === 400) {
        // Not yet connected — leave as connection_sent, retry next session
        log(`Follow-up ${p.name} not yet connected (${msgR.status}) — will retry`);
      } else {
        log(`Follow-up unexpected ${msgR.status} for ${p.name} — ${JSON.stringify(msgR.data || {}).slice(0, 150)}`);
        await handleFailure(`Follow-up to ${p.name}`);
      }
    } catch (e) {
      log(`Follow-up error for ${p.name}: ${e.message}`);
    }
    await withDelay(config);
  }

  log(`Stage 4 complete — ${sent} follow-up messages sent`);
  sendStatusUpdate();
}

// ─── Message Passing ──────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => { popupPort = null; });
  sendStatusUpdate();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const config = await getConfig();
      const isPipelineMsg = ['RUN_ALL', 'RUN_DISCOVER', 'RUN_CONNECT', 'RUN_FOLLOWUP', 'RUN_CLEANUP'].includes(msg.type);
      if (isPipelineMsg) {
        if (isRunning) { log('Already running — ignoring duplicate request'); sendResponse({ ok: false }); return; }
        isRunning = true;
        _halted = false; // clear any prior CAPTCHA halt on new run start
      }
      if (msg.type === 'RUN_ALL') {
        log('=== Run All ===');
        try {
          const ckpt = await loadCheckpoint();
          const startStage = ckpt ? ckpt.stage : 0;
          if (ckpt) log(`Resuming from checkpoint — starting at stage ${startStage} (saved ${ckpt.savedAt})`);

          if (startStage <= 0) { await saveCheckpoint(0); await stagePendingCleanup(config); }
          if (startStage <= 1) { await saveCheckpoint(1); await stageDiscover(config); }
          if (startStage <= 2) { await saveCheckpoint(2); await stageMessageExisting(config); }
          if (startStage <= 3) { await saveCheckpoint(3); await stageConnectNew(config); }
          if (startStage <= 4) { await saveCheckpoint(4); await stageFollowUp(config); }
          await clearCheckpoint();
        } finally { isRunning = false; }
        log('=== Run All complete ===');
      } else if (msg.type === 'RUN_DISCOVER') {
        try { await stageDiscover(config); } finally { isRunning = false; }
      } else if (msg.type === 'RUN_CONNECT') {
        try { await stageConnectNew(config); } finally { isRunning = false; }
      } else if (msg.type === 'RUN_FOLLOWUP') {
        try { await stageFollowUp(config); } finally { isRunning = false; }
      } else if (msg.type === 'RUN_CLEANUP') {
        try { await stagePendingCleanup(config); } finally { isRunning = false; }
      } else if (msg.type === 'CLEAR_PROFILES') {
        await chrome.storage.local.remove('profiles');
        log('All profile data cleared');
        sendStatusUpdate();
      }
    } catch (e) {
      log(`Fatal error: ${e.message}`);
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// ─── Keep-alive Alarm ─────────────────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener(() => {});
