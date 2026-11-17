const DEDUPE_MAX = 1000;

export function createNotifier({ state, push, log = () => {} }) {
  const visible = new Map(); // clientId -> address
  const seen = new Map(); // dedupe key -> { address, to }

  function remember(key, address, to) {
    seen.set(key, { address, to });
    if (seen.size > DEDUPE_MAX) seen.delete(seen.keys().next().value);
  }

  // A different status ends the episode: the next push for this address is new
  // (blocked -> working -> blocked in one turn notifies twice).
  function forgetOnChange(address, to) {
    for (const [key, v] of seen) if (v.address === address && v.to !== to) seen.delete(key);
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
        forgetOnChange(tr.address, tr.to);
        if (state.deskMode) return;
        const title = titleFor(tr);
        if (!title) return;
        const { address } = tr;
        for (const a of visible.values()) if (a === address) return;
        const key = `${address}:${tr.turn}:${tr.to}`;
        if (seen.has(key)) return;
        remember(key, address, tr.to);
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
