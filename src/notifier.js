const DEDUPE_MAX = 1000;

export function createNotifier({ state, push, log = () => {} }) {
  const visible = new Map(); // clientId -> address
  const seen = new Set();

  function remember(key) {
    seen.add(key);
    if (seen.size > DEDUPE_MAX) seen.delete(seen.values().next().value);
  }

  function titleFor(tr) {
    const { agent, space } = tr.item;
    if (tr.to === 'blocked' && tr.from !== 'blocked' && state.notifyBlocked) return `${agent} in ${space} needs you`;
    if (tr.from === 'working' && tr.to === 'done' && state.notifyDone) return `${agent} in ${space} finished — waiting for you`;
    return null;
  }

  return {
    onTransition(tr) {
      try {
        if (state.deskMode) return;
        const title = titleFor(tr);
        if (!title) return;
        const { address } = tr;
        for (const a of visible.values()) if (a === address) return;
        const key = `${address}:${tr.turn}:${tr.to}`;
        if (seen.has(key)) return;
        remember(key);
        const payload = { title, body: 'Tap to open', address, tag: address, url: '/#/t/' + address };
        Promise.resolve(push.sendAll(payload)).catch((e) => log(`notify failed: ${e?.message ?? e}`));
      } catch (e) {
        try { log(`notify failed: ${e?.message ?? e}`); } catch { /* never throw */ }
      }
    },

    setVisible(clientId, address) {
      if (address) visible.set(clientId, address);
      else visible.delete(clientId);
    },
  };
}
