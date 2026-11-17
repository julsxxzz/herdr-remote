// Settings sheet: push notifications, notification triggers, desk mode, sign out everywhere.

import { api, signedOut } from './api.js';
import { el } from './list.js';

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const postSubscription = (sub) => api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });

// Re-register this device's existing subscription, so the server knows it even after a reset.
export async function syncPushSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await postSubscription(sub);
  } catch { /* best effort */ }
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, text: permission === 'denied' ? 'Notifications are blocked. Allow them in Chrome’s site settings, then try again.' : 'Notifications were not allowed.' };
  }
  const key = await api('/api/push/key');
  if (!key.ok || typeof key.data?.publicKey !== 'string') return { ok: false, text: 'Couldn’t get the push key from your computer.' };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key.data.publicKey) });
  }
  const r = await postSubscription(sub);
  return r.ok ? { ok: true } : { ok: false, text: 'Your computer didn’t accept this device.' };
}

function toggleRow({ id, label, help, checked, onChange }) {
  const input = el('input', { type: 'checkbox', role: 'switch', id, class: 'switch' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input));
  return el('div', { class: 'setting' },
    el('label', { for: id, class: 'setting-text' },
      el('span', { class: 'setting-label', text: label }),
      help ? el('span', { class: 'setting-help', text: help }) : null),
    input);
}

export function openSettings() {
  const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'settings-title' });
  const pushBox = el('div', { class: 'setting-block' });
  const togglesBox = el('div', { class: 'setting-list' });
  const signOutBox = el('div', { class: 'setting-block' });

  async function putSetting(input, key) {
    input.disabled = true;
    const r = await api('/api/settings', { method: 'PUT', body: { [key]: input.checked } });
    input.disabled = false;
    if (!r.ok) input.checked = !input.checked;
  }

  async function renderPush(note) {
    const status = el('p', { class: 'setting-help' });
    const parts = [el('h3', { text: 'Notifications on this phone' }), status];
    if (!pushSupported()) {
      status.textContent = 'This browser can’t receive notifications. Open the app over HTTPS in Chrome and add it to the home screen.';
    } else if (Notification.permission === 'denied') {
      status.textContent = 'Notifications are blocked for this site. Allow them in Chrome’s site settings.';
    } else {
      const sub = Notification.permission === 'granted' ? await currentSubscription().catch(() => null) : null;
      if (sub) {
        status.textContent = 'On. You’ll get a notification when an agent needs you or finishes.';
        const result = el('p', { class: 'setting-help', role: 'status' });
        const testBtn = el('button', { type: 'button', class: 'btn', text: 'Send test notification' });
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true;
          result.textContent = 'Sending…';
          const r = await api('/api/push/test', { method: 'POST' });
          testBtn.disabled = false;
          if (!r.ok) result.textContent = 'The test notification couldn’t be sent.';
          else if (r.data?.sent > 0) result.textContent = `Sent to ${r.data.sent} device${r.data.sent === 1 ? '' : 's'}.`;
          else result.textContent = 'No device received it. Turn notifications off and on in Chrome, then enable them again here.';
        });
        parts.push(testBtn, result);
      } else {
        status.textContent = 'Off. Turn them on to hear when an agent needs you.';
        const enableBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Enable notifications' });
        enableBtn.addEventListener('click', async () => {
          enableBtn.disabled = true;
          enableBtn.textContent = 'Enabling…';
          let r;
          try { r = await enablePush(); } catch (err) { r = { ok: false, text: `Couldn’t enable notifications: ${err?.message ?? err}` }; }
          renderPush(r.ok ? null : r.text);
        });
        parts.push(enableBtn);
      }
    }
    if (note) parts.push(el('p', { class: 'setting-error', role: 'alert', text: note }));
    pushBox.replaceChildren(...parts);
  }

  async function renderToggles() {
    const r = await api('/api/settings');
    if (!r.ok) {
      togglesBox.replaceChildren(el('p', { class: 'setting-error', text: 'Couldn’t load settings from your computer.' }));
      return;
    }
    const s = r.data;
    togglesBox.replaceChildren(
      el('h3', { text: 'Notify me when' }),
      toggleRow({ id: 'set-blocked', label: 'An agent needs you', help: 'A permission prompt, question or sign-in is waiting.', checked: s.notifyBlocked, onChange: (i) => putSetting(i, 'notifyBlocked') }),
      toggleRow({ id: 'set-done', label: 'An agent finishes', help: 'A turn ended and it’s waiting for your reply.', checked: s.notifyDone, onChange: (i) => putSetting(i, 'notifyDone') }),
      toggleRow({ id: 'set-desk', label: 'Desk mode', help: 'Pause all notifications while you’re at the computer.', checked: s.deskMode, onChange: (i) => putSetting(i, 'deskMode') }),
    );
  }

  function renderSignOut(confirming = false) {
    const head = el('h3', { text: 'Sign out everywhere' });
    if (!confirming) {
      const btn = el('button', { type: 'button', class: 'btn btn-danger', text: 'Sign out everywhere' });
      btn.addEventListener('click', () => renderSignOut(true));
      signOutBox.replaceChildren(head, el('p', { class: 'setting-help', text: 'Every phone and browser will need the PIN again.' }), btn);
      return;
    }
    const yes = el('button', { type: 'button', class: 'btn btn-danger', text: 'Sign out all devices' });
    const no = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
    no.addEventListener('click', () => renderSignOut(false));
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      no.disabled = true;
      const r = await api('/api/logout-everywhere', { method: 'POST' });
      if (r.ok) { dialog.close(); signedOut(); return; }
      if (r.status === 401) { dialog.close(); return; }
      renderSignOut(false);
    });
    signOutBox.replaceChildren(head,
      el('p', { class: 'setting-help', text: 'Sign out every device, including this one?' }),
      el('div', { class: 'btn-row' }, no, yes));
  }

  const closeBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close settings', text: '×' });
  closeBtn.addEventListener('click', () => dialog.close());
  dialog.append(el('div', { class: 'sheet-inner' },
    el('div', { class: 'sheet-head' }, el('h2', { id: 'settings-title', text: 'Settings' }), closeBtn),
    pushBox, togglesBox, signOutBox,
  ));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  renderPush();
  renderToggles();
  renderSignOut();
  dialog.showModal();
  closeBtn.focus();
  return dialog;
}
