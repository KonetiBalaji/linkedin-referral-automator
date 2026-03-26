'use strict';

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
  isPremium:     false,
  searchQueryId: '',
};

let companies = [];
let roles = [];

// ─── Port connection (log streaming from service worker) ──────────────────────

function connectPort() {
  const port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(msg => {
    if (msg.type === 'LOG') appendLog(msg.message);
    if (msg.type === 'STATUS_UPDATE') updateCounts(msg.counts);
    if (msg.type === 'CAPTCHA_DETECTED') {
      document.getElementById('captcha-alert').style.display = 'block';
      appendLog('CAPTCHA / challenge detected — solve it on linkedin.com then try again');
    }
  });
  port.onDisconnect.addListener(() => {
    // SW killed — reconnect silently on next user action
  });
}

// ─── Log ──────────────────────────────────────────────────────────────────────

function appendLog(text) {
  const log = document.getElementById('log');
  const entry = document.createElement('div');
  const lower = text.toLowerCase();
  let cls = 'log-entry';
  if (lower.includes('✓') || lower.includes('success') || lower.includes('complete')) cls += ' ok';
  else if (lower.includes('limit') || lower.includes('retry') || lower.includes('backing off') || lower.includes('skipping')) cls += ' warn';
  else if (lower.includes('error') || lower.includes('failed') || lower.includes('fatal') || lower.includes('abort')) cls += ' error';
  entry.className = cls;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

// ─── Status counts ────────────────────────────────────────────────────────────

function updateCounts(counts) {
  for (const [key, val] of Object.entries(counts)) {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = val;
  }
}

// ─── Tag inputs ───────────────────────────────────────────────────────────────

function renderTags(containerId, inputId, items, onRemove) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  container.querySelectorAll('.tag').forEach(t => t.remove());
  for (let i = 0; i < items.length; i++) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${escapeHtml(items[i])} <span class="remove" data-i="${i}">&times;</span>`;
    tag.querySelector('.remove').addEventListener('click', () => onRemove(i));
    container.insertBefore(tag, input);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setupTagInput(containerId, inputId, getItems, setItems, onCommit) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);

  function refresh() {
    renderTags(containerId, inputId, getItems(), i => {
      const arr = [...getItems()];
      arr.splice(i, 1);
      setItems(arr);
      refresh();
      onCommit();
    });
  }

  container.addEventListener('click', () => input.focus());

  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().replace(/,+$/, '');
      if (val && !getItems().includes(val)) {
        setItems([...getItems(), val]);
        refresh();
        onCommit();
      }
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value) {
      const arr = [...getItems()];
      if (arr.length) { arr.pop(); setItems(arr); refresh(); onCommit(); }
    }
  });

  return refresh;
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function loadConfig() {
  const { config } = await chrome.storage.local.get('config');
  const saved = config || {};

  companies = (saved.companies && saved.companies.length) ? [...saved.companies] : [...DEFAULT_CONFIG.companies];
  roles     = (saved.roles && saved.roles.length)         ? [...saved.roles]     : [...DEFAULT_CONFIG.roles];

  document.getElementById('connection-note').value  = saved.connectionNote  ?? DEFAULT_CONFIG.connectionNote;
  document.getElementById('referral-message').value = saved.referralMessage ?? DEFAULT_CONFIG.referralMessage;
  document.getElementById('max-connections').value  = saved.maxConnectionsPerRun ?? DEFAULT_CONFIG.maxConnectionsPerRun;
  document.getElementById('max-messages').value     = saved.maxMessagesPerRun    ?? DEFAULT_CONFIG.maxMessagesPerRun;
  document.getElementById('action-delay').value     = saved.actionDelayMs        ?? DEFAULT_CONFIG.actionDelayMs;
  document.getElementById('is-premium').checked     = saved.isPremium            ?? DEFAULT_CONFIG.isPremium;
  document.getElementById('search-query-id').value  = saved.searchQueryId        ?? DEFAULT_CONFIG.searchQueryId;

  refreshCompanies();
  refreshRoles();
  updateNoteCounter();
}

function saveConfig() {
  const config = {
    companies: [...companies],
    roles: [...roles],
    connectionNote:       document.getElementById('connection-note').value,
    referralMessage:      document.getElementById('referral-message').value,
    maxConnectionsPerRun: parseInt(document.getElementById('max-connections').value, 10) || 15,
    maxMessagesPerRun:    parseInt(document.getElementById('max-messages').value,    10) || 15,
    actionDelayMs:        parseInt(document.getElementById('action-delay').value,    10) || 4000,
    isPremium:            document.getElementById('is-premium').checked,
    searchQueryId:        document.getElementById('search-query-id').value.trim(),
  };
  chrome.storage.local.set({ config });
}

// ─── Char counter ─────────────────────────────────────────────────────────────

function updateNoteCounter() {
  const ta      = document.getElementById('connection-note');
  const counter = document.getElementById('note-counter');
  const hint    = document.getElementById('note-limit-hint');
  const premium = document.getElementById('is-premium').checked;
  const limit   = premium ? 300 : 200;
  const len     = ta.value.length;
  counter.textContent = `${len} / ${limit}`;
  counter.classList.toggle('over', len > limit);
  if (hint) hint.textContent = premium ? '(max 300 chars — Premium)' : '(max 200 chars — free)';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let refreshCompanies, refreshRoles;

document.addEventListener('DOMContentLoaded', async () => {
  refreshCompanies = setupTagInput('company-tags', 'company-input', () => companies, v => { companies = v; }, saveConfig);
  refreshRoles     = setupTagInput('role-tags',    'role-input',    () => roles,     v => { roles = v; },     saveConfig);

  await loadConfig();
  connectPort();

  document.getElementById('connection-note').addEventListener('input',  () => { updateNoteCounter(); saveConfig(); });
  document.getElementById('referral-message').addEventListener('input', saveConfig);
  document.getElementById('max-connections').addEventListener('change', saveConfig);
  document.getElementById('max-messages').addEventListener('change',    saveConfig);
  document.getElementById('action-delay').addEventListener('change',    saveConfig);
  document.getElementById('is-premium').addEventListener('change',      () => { updateNoteCounter(); saveConfig(); });
  document.getElementById('search-query-id').addEventListener('input',  saveConfig);

  function clearCaptchaAlert() {
    document.getElementById('captcha-alert').style.display = 'none';
  }

  document.getElementById('btn-run-all').addEventListener('click', () => {
    clearCaptchaAlert();
    chrome.runtime.sendMessage({ type: 'RUN_ALL' });
    appendLog('Run All triggered');
  });
  document.getElementById('btn-discover').addEventListener('click', () => {
    clearCaptchaAlert();
    chrome.runtime.sendMessage({ type: 'RUN_DISCOVER' });
    appendLog('Discover triggered');
  });
  document.getElementById('btn-connect').addEventListener('click', () => {
    clearCaptchaAlert();
    chrome.runtime.sendMessage({ type: 'RUN_CONNECT' });
    appendLog('Connect triggered');
  });
  document.getElementById('btn-followup').addEventListener('click', () => {
    clearCaptchaAlert();
    chrome.runtime.sendMessage({ type: 'RUN_FOLLOWUP' });
    appendLog('Follow-up triggered');
  });
  document.getElementById('btn-cleanup').addEventListener('click', () => {
    clearCaptchaAlert();
    chrome.runtime.sendMessage({ type: 'RUN_CLEANUP' });
    appendLog('Cleanup triggered');
  });
document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Clear all discovered profile data? This cannot be undone.')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_PROFILES' });
    }
  });
});
