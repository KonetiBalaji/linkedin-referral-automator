'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const LI_BASE = 'https://www.linkedin.com';
const MAX_NOTE_LENGTH = 300;
const BACKOFF_DELAYS = [30000, 60000, 120000, 300000]; // ms — cap 300s

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
  actionDelayMs: 4000,
};

let popupPort = null;
let consecutiveFailures = 0;
let isRunning = false;

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
// Returns: { status: number, data: object|null }

async function apiCall(path, postBody = null) {
  const tabId = await getLinkedInTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (path, postBody) => {
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
      }

      try {
        const res = await fetch(`https://www.linkedin.com${path}`, init);
        let data = null;
        try { data = await res.json(); } catch (_) {}
        return { status: res.status, data };
      } catch (e) {
        return { status: 0, data: null, error: e.message };
      }
    },
    args: [path, postBody],
  });
  return results?.[0]?.result ?? { status: 0, data: null };
}

const ok   = r => r.status >= 200 && r.status < 300;
const get  = path        => apiCall(path, null);
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
        let data = null;
        try { data = await res.json(); } catch (_) {}
        return { status: res.status, data };
      } catch (e) {
        return { status: 0, data: null, error: e.message };
      }
    },
    args: [path, body],
  });
  return results?.[0]?.result ?? { status: 0, data: null };
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

// ─── Delay & backoff ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withDelay(config) {
  await sleep(config.actionDelayMs);
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

// ─── My URN (sender identity) ─────────────────────────────────────────────────

let _myUrn = null;

async function getMyUrn() {
  if (_myUrn) return _myUrn;
  const r = await get('/voyager/api/me');
  if (!ok(r) || !r.data) { log(`getMyUrn: /me returned ${r.status}`); return null; }
  // Try normalized shape first, then included[]
  let urn = r.data?.data?.entityUrn || null;
  if (!urn) {
    for (const item of (r.data?.included || [])) {
      if (item?.entityUrn?.includes('fsd_profile') || item?.entityUrn?.includes('miniProfile')) {
        urn = item.entityUrn; break;
      }
    }
  }
  if (urn && !urn.includes('fsd_profile')) {
    // miniProfile URN → convert to fsd_profile (same base ID, different type prefix)
    urn = urn.replace(/urn:li:\w+:/, 'urn:li:fsd_profile:');
  }
  _myUrn = urn;
  log(`getMyUrn: ${_myUrn}`);
  return _myUrn;
}

// ─── Messaging (new Dash endpoint) ────────────────────────────────────────────
// Endpoint: POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
// Content-Type: text/plain;charset=UTF-8
// Requires: mailboxUrn (our own fsd_profile URN) + conversationUrn (from lookup)

async function getConversationUrn(recipientUrn, myUrn) {
  // Find existing conversation with this person
  const r = await get(
    `/voyager/api/voyagerMessagingDashMessengerConversations` +
    `?q=participants&recipients=List(${encodeURIComponent(recipientUrn)})` +
    `&mailboxUrn=${encodeURIComponent(myUrn)}`
  );
  if (!ok(r) || !r.data) return null;

  // Try normalized shape: data.elements[]
  const elements = r.data?.data?.elements || r.data?.elements || [];
  if (elements.length > 0) {
    const urn = elements[0]?.entityUrn || elements[0]?.conversationUrn;
    if (urn) return urn;
  }
  // Try included[]
  for (const item of (r.data?.included || [])) {
    const urn = item?.entityUrn || '';
    if (urn.includes('msg_conversation')) return urn;
  }
  return null;
}

async function sendMessageDash(recipientUrn, text, myUrn) {
  // Step 1: look for an existing conversation
  let convUrn = await getConversationUrn(recipientUrn, myUrn);
  log(`sendMessageDash convUrn: ${convUrn}`);

  if (convUrn) {
    // Existing conversation — send directly
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

  // Step 2: no existing conversation — createMessage with top-level recipients
  // (LinkedIn auto-creates the conversation on first message)
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

// ─── Stage 1: Discover ────────────────────────────────────────────────────────

function companyNameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

async function resolveCompanyUrn(companyName) {
  // Primary: universalName lookup — reliable for well-known companies
  try {
    const slug = companyNameToSlug(companyName);
    const r = await get(`/voyager/api/organization/companies?q=universalName&universalName=${encodeURIComponent(slug)}`);
    log(`universalName "${slug}" → ${r.status}`);
    if (ok(r) && r.data) {
      // Response: data["*elements"][0] = "urn:li:fs_normalized_company:1441"
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

async function searchPeople(companyId, role, start = 0) {
  // search/blended (404) and graphql queryId (400) are both dead.
  // search/dash/clusters is the working endpoint (confirmed 200).
  // query structure must NOT be encodeURIComponent'd — LinkedIn parses parens/colons as literals.
  // Only the role keyword (which may contain spaces) needs encoding.
  const keywords = encodeURIComponent(role);
  const r = await get(
    `/voyager/api/search/dash/clusters?q=all` +
    `&query=(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:(currentCompany:List(${companyId}),resultType:List(PEOPLE)))` +
    `&start=${start}&count=20`
  );
  if (!ok(r)) { log(`search [${role}@${companyId}] → ${r.status}`); return []; }

  // Normalized response format — see REFERENCES.md §2b for full shape explanation.
  //   data.elements[].items[].itemUnion["*entityResult"] = "urn:li:fsd_entityResultViewModel:(...)"
  //   included[] contains EntityResultViewModel objects keyed by that URN
  //   Profile URN is embedded inside the entityResultViewModel URN string

  // Build lookup from entityUrn → included object
  const byUrn = {};
  for (const item of (r.data?.included || [])) {
    if (item?.entityUrn) byUrn[item.entityUrn] = item;
  }

  const people = [];
  for (const cluster of (r.data?.data?.elements || [])) {
    for (const searchItem of (cluster?.items || [])) {
      const entityResultUrn = searchItem?.itemUnion?.['*entityResult'];
      if (!entityResultUrn) continue;

      // Extract urn:li:fsd_profile:XYZ from within the entityResultViewModel URN
      const profileMatch = entityResultUrn.match(/(urn:li:fsd_profile:[^,)]+)/);
      if (!profileMatch) continue;
      const profileUrn = profileMatch[1];

      // Resolve entity data from included
      const entity = byUrn[entityResultUrn];
      const name = entity?.title?.text;
      if (!name) continue;

      const distance = entity?.entityCustomTrackingInfo?.memberDistance ?? null;
      const navUrl = entity?.navigationUrl || '';
      const navMatch = navUrl.match(/\/in\/([^/?]+)/);

      people.push({ urn: profileUrn, name, distance, public_id: navMatch ? navMatch[1] : null });
    }
  }

  log(`dash/clusters [${role}@${companyId}] → ${people.length} people`);
  return people;
}

async function stageDiscover(config) {
  log('Stage 1: Discover — starting');
  const profiles = await getProfiles();
  let newCount = 0;

  for (const company of config.companies) {
    const companyId = await resolveCompanyUrn(company);
    if (!companyId) continue;
    log(`"${company}" → ID ${companyId}`);

    for (const role of config.roles) {
      let start = 0;
      for (let page = 0; page < 5; page++) {
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
  log('Stage 2: Message existing connections — starting');
  const myUrn = await getMyUrn();
  if (!myUrn) { log('Stage 2: could not resolve own URN — aborting'); return; }
  const profiles = await getProfiles();
  let sent = 0;

  for (const [urn, p] of Object.entries(profiles)) {
    if (sent >= config.maxMessagesPerRun) { log('Max messages/run reached'); break; }
    if (p.status !== 'discovered') continue;
    if (p.distance !== 'DISTANCE_1' && p.distance !== 1) continue;

    try {
      const r = await sendMessageDash(urn, fillTemplate(config.referralMessage, p), myUrn);
      if (ok(r)) {
        await updateProfile(urn, { status: 'message_sent', message_sent_at: new Date().toISOString() });
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
  log('Stage 3: Send connection requests — starting');
  const profiles = await getProfiles();
  let sent = 0;

  for (const [urn, p] of Object.entries(profiles)) {
    if (sent >= config.maxConnectionsPerRun) { log('Max connections/run reached'); break; }
    if (p.status !== 'discovered') continue;
    if (p.distance === 'DISTANCE_1' || p.distance === 1) continue;

    const note = fillTemplate(config.connectionNote, p).slice(0, MAX_NOTE_LENGTH);
    try {
      const r = await post(
        '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
        { invitee: { inviteeUnion: { memberProfile: urn } }, customMessage: note }
      );

      if (r.status === 201 || r.status === 200) {
        await updateProfile(urn, { status: 'connection_sent', connection_sent_at: new Date().toISOString() });
        log(`Connection sent to ${p.name} ✓ (${r.status})`);
        sent++;
        resetFailures();
      } else if (r.status === 429) {
        const body = JSON.stringify(r.data || {});
        if (body.includes('WEEKLY_LIMIT') || body.includes('invitationsSentInLast7Days')) {
          log('Weekly connection limit hit — stopping');
          break;
        }
        await handleFailure(`429 on connect to ${p.name}`);
      } else if (r.status === 400) {
        log(`${p.name} already connected or pending — skipping`);
        await updateProfile(urn, { status: 'skipped' });
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

// ─── Stage 4: Follow-up After Acceptance ─────────────────────────────────────

async function stageFollowUp(config) {
  log('Stage 4: Follow-up on accepted connections — starting');
  const myUrn = await getMyUrn();
  if (!myUrn) { log('Stage 4: could not resolve own URN — aborting'); return; }
  const profiles = await getProfiles();
  let sent = 0;

  for (const [urn, p] of Object.entries(profiles)) {
    if (sent >= config.maxMessagesPerRun) { log('Max messages/run reached'); break; }
    if (p.status !== 'connection_sent') continue;

    try {
      const msgR = await sendMessageDash(urn, fillTemplate(config.referralMessage, p), myUrn);
      log(`follow-up ${p.name} → ${msgR.status} | ${JSON.stringify(msgR.data || {}).slice(0, 150)}`);
      if (ok(msgR)) {
        await updateProfile(urn, { status: 'message_sent', message_sent_at: new Date().toISOString() });
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
      // Guard against concurrent pipeline runs (duplicate message delivery in MV3)
      const isPipelineMsg = ['RUN_ALL','RUN_DISCOVER','RUN_CONNECT','RUN_FOLLOWUP'].includes(msg.type);
      if (isPipelineMsg) {
        if (isRunning) { log('Already running — ignoring duplicate request'); sendResponse({ ok: false }); return; }
        isRunning = true;
      }
      if (msg.type === 'RUN_ALL') {
        log('=== Run All ===');
        try {
          await stageDiscover(config);
          await stageMessageExisting(config);
          await stageConnectNew(config);
          await stageFollowUp(config);
        } finally { isRunning = false; }
        log('=== Run All complete ===');
      } else if (msg.type === 'RUN_DISCOVER') {
        try { await stageDiscover(config); } finally { isRunning = false; }
      } else if (msg.type === 'RUN_CONNECT') {
        try { await stageConnectNew(config); } finally { isRunning = false; }
      } else if (msg.type === 'RUN_FOLLOWUP') {
        try { await stageFollowUp(config); } finally { isRunning = false; }
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
