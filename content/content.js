'use strict';

// DOM fallback — only activated by service worker when Voyager API returns non-2xx.
// Handles connect-with-note and message via LinkedIn's DOM.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'DOM_CONNECT') {
    domConnect(msg.note).then(ok => sendResponse({ ok }));
    return true; // async response
  }
  if (msg.type === 'DOM_MESSAGE') {
    domMessage(msg.body).then(ok => sendResponse({ ok }));
    return true;
  }
});

// ─── Connect with note ────────────────────────────────────────────────────────

async function domConnect(note) {
  try {
    const connectBtn = findButtonByText('Connect');
    if (!connectBtn) { console.warn('[LRA] Connect button not found'); return false; }
    connectBtn.click();

    await waitFor('[aria-label="Add a note"]', 3000);
    const addNoteBtn = document.querySelector('[aria-label="Add a note"]');
    if (!addNoteBtn) return false;
    addNoteBtn.click();

    await waitFor('textarea[name="message"]', 3000);
    const textarea = document.querySelector('textarea[name="message"]');
    if (!textarea) return false;

    setReactValue(textarea, note.slice(0, 300));
    await sleep(400);

    const sendBtn = document.querySelector('button[aria-label="Send invitation"]');
    if (!sendBtn) return false;
    sendBtn.click();
    return true;
  } catch (e) {
    console.error('[LRA] domConnect error:', e);
    return false;
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function domMessage(body) {
  try {
    const messageBtn = findButtonByText('Message');
    if (!messageBtn) { console.warn('[LRA] Message button not found'); return false; }
    messageBtn.click();

    await waitFor('.msg-form__contenteditable', 3000);
    const editor = document.querySelector('.msg-form__contenteditable');
    if (!editor) return false;

    setReactValue(editor, body);
    await sleep(400);

    const sendBtn = document.querySelector('button.msg-form__send-button');
    if (!sendBtn) return false;
    sendBtn.click();
    return true;
  } catch (e) {
    console.error('[LRA] domMessage error:', e);
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findButtonByText(label) {
  return [...document.querySelectorAll('button')].find(
    b => b.textContent.trim().toLowerCase() === label.toLowerCase()
  ) || null;
}

// Wait for a selector to appear in the DOM
function waitFor(selector, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`[LRA] Timeout waiting for selector: ${selector}`));
    }, timeout);
  });
}

// Trigger React's synthetic input event — required for React-controlled inputs
function setReactValue(el, value) {
  // For textarea elements, use HTMLTextAreaElement prototype setter
  // For contenteditable divs, fall back to textContent
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.textContent = value;
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
