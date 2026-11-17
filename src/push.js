import * as defaultWebpush from 'web-push';

export function generateVapidKeys(webpush = defaultWebpush) {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

export function createPush({ vapid, subject, state, saveState, webpush = defaultWebpush, log = () => {} }) {
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];

  return {
    publicKey: vapid.publicKey,

    subscribe(sub) {
      state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      state.subscriptions.push(sub);
      saveState(state);
    },

    unsubscribe(endpoint) {
      state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
      saveState(state);
    },

    async sendAll(payload) {
      const body = JSON.stringify(payload);
      const subs = [...state.subscriptions];
      const dead = new Set();
      let sent = 0;
      await Promise.all(
        subs.map(async (s) => {
          try {
            await webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' });
            sent++;
          } catch (err) {
            if (err?.statusCode === 404 || err?.statusCode === 410) dead.add(s.endpoint);
            else log(`push failed (${err?.statusCode ?? 'error'}): ${err?.message ?? err}`);
          }
        }),
      );
      if (dead.size) {
        state.subscriptions = state.subscriptions.filter((s) => !dead.has(s.endpoint));
        saveState(state);
      }
      return { sent, removed: dead.size };
    },
  };
}
