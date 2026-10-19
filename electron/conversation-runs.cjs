// A request owns one conversation until it settles. Other conversations remain independent.
function createConversationRuns() {
  const sessions = new Map(), requests = new Map();
  return {
    begin(id, session) {
      if (requests.has(id)) throw new Error('请求标识已在使用');
      if (sessions.has(session)) throw new Error('这段对话已有回复正在生成，请等待或停止本段回复');
      const controller = new AbortController();
      requests.set(id, controller); sessions.set(session, id);
      let finished = false;
      return { controller, finish() {
        if (finished) return;
        finished = true;
        if (sessions.get(session) === id) sessions.delete(session);
        requests.delete(id);
      } };
    },
    requests,
    busy: session => sessions.has(session),
  };
}
module.exports = { createConversationRuns };
