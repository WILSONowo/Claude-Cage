export const sessionKey = tab => tab.cli_session_id ? `session:${tab.cli_session_id}` : tab.id;

export function projectSessionRows(tabs, sessions, saved, manualOrder, baseline) {
  const bySession = new Map();
  for (const session of sessions) if (!bySession.has(session.id)) bySession.set(session.id, session);
  const live = tabs.filter(tab => !tab.closed || !bySession.has(tab.cli_session_id));
  const byTab = new Map();
  for (const tab of live) if (!byTab.has(tab.cli_session_id)) byTab.set(tab.cli_session_id, tab);
  const rows = [
    ...sessions.map(session => byTab.get(session.id) || ({
      id: `session:${session.id}`, kind: "terminal", workspace: session.workspace,
      title: session.title, cli_session_id: session.id, historySession: session,
      claudeAccountNumber: session.claudeAccountNumber,
    })),
    ...live.filter(tab => !bySession.has(tab.cli_session_id)),
  ].map(tab => {
    const session = bySession.get(tab.cli_session_id);
    return { ...tab, claudeAccountNumber: session?.account_id ? session.claudeAccountNumber : tab.claudeAccountNumber,
      sessionActive: Boolean(session?.active),
      sessionRunningElsewhere: Boolean(tab.historySession && session?.running),
      sessionPinned: Boolean(session ? session.pinned : saved[tab.id]?.pinned) };
  });
  for (const row of rows) if (!baseline.has(sessionKey(row))) baseline.set(sessionKey(row), baseline.size);
  const manualRanks = new Map();
  manualOrder?.forEach((key, index) => { if (!manualRanks.has(key)) manualRanks.set(key, index); });
  const rank = row => manualRanks.get(sessionKey(row)) ?? manualOrder?.length;
  return rows.sort((a, b) => {
    if (manualOrder) return rank(a) - rank(b) || baseline.get(sessionKey(a)) - baseline.get(sessionKey(b));
    return Number(b.sessionActive) - Number(a.sessionActive) || Number(b.sessionPinned) - Number(a.sessionPinned) ||
      baseline.get(sessionKey(a)) - baseline.get(sessionKey(b));
  });
}
