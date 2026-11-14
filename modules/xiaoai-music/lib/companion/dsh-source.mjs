const sessionKey = value => typeof value === 'string' ? value.replace(/^session-/, '') : '';

// Inspect only committed provenance and call identity, never message text.
export function isDirectDshCall(exec, boundSessionId) {
  try {
    if (exec?.signal?.aborted !== false) return false;
    const session = exec?.agent?.session;
    const expected = sessionKey(boundSessionId);
    if (!expected || sessionKey(session?.id) !== expected ||
        typeof session?.eventAt !== 'function' || !Number.isSafeInteger(session.seq) || session.seq < 1) return false;
    const anchor = exec.rootCallId || exec.callId;
    if (typeof anchor !== 'string' || !anchor) return false;
    let directUser = false;
    let callTurn;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (!event || event.type === 'turn/end') return false;
      if (event.type === 'tool/call' && event.data?.callId === anchor) callTurn = event.data.turn;
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') directUser = true;
      if (event.type === 'turn/start') {
        const turn = event.data?.turn;
        return Number.isSafeInteger(turn) && turn >= 0 && directUser && callTurn === turn;
      }
    }
    return false;
  } catch { return false; }
}
