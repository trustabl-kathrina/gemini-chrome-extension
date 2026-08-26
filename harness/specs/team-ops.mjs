// Scene 5 — Team ops. PLAN: a confirm answered allow; fake log has ≥1 create_issue and create_pull_request;
// a `type` on the fake chat page (/chat stands in for Telegram) — proven by a message recorded by the fake messenger.
export default {
  prompt: ({ wspUrl }) =>
    `Post this week's update to the "Diploma · Team" chat in the messenger at ${wspUrl}/chat, create Linear issues for the next milestone, and open a GitHub issue and a pull request for the diploma repo (dayflow-student/diploma).`,
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    if (!r.confirms.some((c) => c.answer === 'allowed')) f.push('no confirmation card was shown and allowed');
    const names = ctx.connectorCalls.map((c) => c.tool);
    for (const want of ['create_issue', 'create_pull_request']) if (!names.includes(want)) f.push(`no ${want} in the fake-connector log (calls: [${names.join(', ') || 'none'}])`);
    const typed = r.steps.some((s) => s.kind === 'tool' && /^type(_text)?$/.test(s.name));
    if (!typed) f.push(`no type/type_text tool step in the run (tools: [${Object.keys(r.toolCalls).join(', ')}])`);
    if (!ctx.chatMessages.length) f.push('the fake messenger received no message (nothing was typed and sent on /chat)');
    return f;
  },
};
