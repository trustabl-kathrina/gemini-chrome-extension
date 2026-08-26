// Scene 3 — Team ops (PLAN v2): a confirmation card answered (harness auto-allows); the message is present on the fake
// chat page ("Diploma · Team", read from the DOM); fake log has create_issue ≥1 and create_pull_request exactly 1.
export default {
  prompt: ({ wspUrl }) =>
    `Summarise this week's work on the diploma repo (dayflow-student/diploma) and post the update to the "Diploma · Team" chat in the messenger at ${wspUrl}/chat (ask me before sending). Then create Linear issues for the next milestone and open a GitHub issue and one pull request for the repo.`,
  realPrompt: () =>
    'Summarise this week\'s work on the diploma repo (dayflow-student/diploma) and post the update to the "Diploma · Team" chat on Telegram Web (ask me before sending). Then create Linear issues for the next milestone and open a GitHub issue and one pull request for the repo.',
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    if (!r.confirms.some((c) => c.answer === 'allowed')) f.push('no confirmation card was shown and allowed before sending');
    const names = ctx.connectorCalls.map((c) => c.tool);
    const issues = names.filter((n) => n === 'create_issue').length;
    const prs = names.filter((n) => n === 'create_pull_request').length;
    if (issues < 1) f.push(`create_issue calls: ${issues}, expected ≥1 (calls: [${names.join(', ') || 'none'}])`);
    if (prs !== 1) f.push(`create_pull_request calls: ${prs}, expected exactly 1 (calls: [${names.join(', ') || 'none'}])`);
    const sent = [...ctx.chatDom, ...ctx.chatMessages.map((m) => ({ chat: m.chatName, text: m.text, via: 'api' }))];
    const diploma = sent.filter((m) => /Diploma/i.test(m.chat || ''));
    if (!ctx.real && !ctx.chatDom.length && ctx.chatMessages.length) f.push('a message was sent but the /chat tab was closed before the run ended (message not visible in the DOM)');
    if (!diploma.length) f.push(`no message present in the "Diploma · Team" chat (sent: ${JSON.stringify(sent).slice(0, 200) || 'none'})`);
    else if (diploma.every((m) => (m.text || '').trim().length < 20)) f.push(`the posted update is too short: ${JSON.stringify(diploma.map((m) => m.text))}`);
    if (r.actions > 40) f.push(`${r.actions} browser actions, cap is 40`);
    return f;
  },
};
