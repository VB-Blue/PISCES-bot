const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { modelResponse, runAssistant, TRUNCATED_NOTICE, THINKING_EXHAUSTED_NOTICE } = require('../electron/assistant-worker.cjs');

test('window consent cannot be transferred to a different AI destination', async () => {
  const commands = [];
  await assert.rejects(runAssistant({ settings: { endpoint: 'http://127.0.0.1:2', model: 'changed' }, work: { id: 'work', desktop_scope: { teacher_destination: 'http://127.0.0.1:1 | original' } }, core: async body => { commands.push(body); }, signal: new AbortController().signal }), /授权的 AI 地址或模型/);
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'finish'); assert.equal(commands[0].status, 'failed');
});

test('a lost action response stops further model requests and does not claim non-delivery', async () => {
  let calls = 0;
  const server = http.createServer(async (req,res) => {
    for await (const _ of req) {} calls++;
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"file_id":"file_0"}'}}]}}]}));
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const events = [];
  try {
    await assert.rejects(runAssistant({settings:{endpoint:'http://127.0.0.1:'+server.address().port,model:'local-test'},apiKey:'',work:{id:'work',goal:'read',profile_snapshot:{},files:[{id:'file_0',name:'selected'}],roles:['executor']},messages:[{role:'user',content:'read'}],signal:new AbortController().signal,emit:()=>{},core:async body=>{
      events.push(body);
      if(body.action==='reserve_call')return {call:{id:'call'}};
      if(body.action==='tool')throw new Error('connection lost after dispatch');
      if(body.action==='reject_proposal')return {receipt:{status:'denied'}};
      return {};
    }}), /结果需要核对/);
    assert.equal(calls,1); assert.equal(events.at(-1).action,'finish'); assert.equal(events.at(-1).status,'failed');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('streamed tool arguments survive chunk boundaries and only executor receives tools', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"file_' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'id":"file_0"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 7 } },
    ];
    const wire = events.map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
    res.write(wire.slice(0, 43)); res.end(wire.slice(43));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'test' };
    const result = await modelResponse(settings, '', [{ role: 'user', content: 'test' }], 'executor', AbortSignal.timeout(3000));
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { file_id: 'file_0' });
    assert.equal(result.message.tool_calls[0].function.name, 'read_file'); assert.equal(result.usage.total_tokens, 7);
    await modelResponse(settings, '', [{ role: 'user', content: 'test' }], 'verifier', AbortSignal.timeout(3000));
    assert.equal(requests[0].tools.length, 2); assert.equal(requests[1].tools, undefined);
    await modelResponse(settings, '', [{ role: 'user', content: 'bounded desktop test' }], 'executor', AbortSignal.timeout(3000), true);
    assert.deepEqual(requests[2].tools.map(t => t.function.name), ['read_file','write_inventory','observe_desktop','desktop_action']);
    assert.equal(requests[2].parallel_tool_calls, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('high-risk desktop action prompts human approval and scrolls translate to key chords', async () => {
  let callCount = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
    callCount++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (callCount === 1) {
      // Step 1: LLM proposes scroll action
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'scroll-1',
              type: 'function',
              function: {
                name: 'desktop_action',
                arguments: JSON.stringify({ snapshot_id: 'snap-1', operation: 'scroll', scroll_direction: 'down' })
              }
            }]
          }
        }]
      }));
    } else if (callCount === 2) {
      // Step 2: LLM proposes click action that gets blocked by core policy
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'click-1',
              type: 'function',
              function: {
                name: 'desktop_action',
                arguments: JSON.stringify({ snapshot_id: 'snap-1', operation: 'click', element_id: 'btn-delete' })
              }
            }]
          }
        }]
      }));
    } else {
      // Step 3: LLM concludes
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '已安全完成所有操作。'
          }
        }]
      }));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const approvalCalls = [];
  const coreActions = [];
  const work = {
    id: 'work-desktop-1',
    goal: '清理操作',
    profile_snapshot: {},
    files: [],
    desktop_scope: {
      teacher_destination: 'http://127.0.0.1:' + server.address().port + ' | test-model',
      surface: { window_title: '敏感管理后台' }
    },
    roles: ['executor']
  };

  try {
    const result = await runAssistant({
      settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'test-model' },
      apiKey: '',
      work,
      messages: [{ role: 'user', content: '请帮我清理' }],
      signal: new AbortController().signal,
      emit: () => {},
      requestApproval: async (payload) => {
        approvalCalls.push(payload);
        return true; // Human approved
      },
      core: async (body) => {
        coreActions.push(body);
        if (body.action === 'reserve_call') return { call: { id: 'call-' + callCount } };
        if (body.action === 'desktop_act') {
          if (body.proposal.operation === 'key_chord') {
            assert.equal(body.proposal.key_chord, 'Down');
            return { ok: true, receipt: { status: 'executed' } };
          }
          if (body.proposal.operation === 'click') {
            throw new Error('desktop_action requires_confirmation: 删除按钮属于高危控件');
          }
        }
        if (body.action === 'finish') return { ok: true };
        return {};
      }
    });

    assert.match(result.text, /尚未完成或核对/);
    assert.equal(result.executionStatus, 'incomplete');
    const approvedFeedback = JSON.parse(requests.at(-1).messages.find(item => item.tool_call_id === 'click-2')?.content || requests.at(-1).messages.filter(item => item.role === 'tool').at(-1).content);
    assert.equal(approvedFeedback.ok, false);
    assert.equal(approvedFeedback.execution_status, 'not_executed');
    assert.equal(result.trace.at(-1).ok, false);
    assert.equal(coreActions.at(-1).status, 'failed');
    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0].windowTitle, '敏感管理后台');
    assert.equal(approvalCalls[0].proposal.operation, 'click');
    assert.match(approvalCalls[0].reason, /requires_confirmation/);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

async function withModelServer(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const response = await handler(body, requests.length);
    res.writeHead(response.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body || { choices: [{ message: response.message || { role: 'assistant', content: '结果已整理' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = { settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'fixture' }, apiKey: '',
    work: { id: 'work', goal: '执行任务', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: '执行任务' }],
    signal: new AbortController().signal, coreTools: false, emit: () => {} };
  try { return await run(base, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const proposedTool = (name, args = {}, id = 'step') => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const fixtureCore = commands => async body => { commands.push(body); return body.action === 'reserve_call' ? { call: { id: 'call' } } : { work: {} }; };
const fixtureTools = (name, execute) => ({ names: [name], definitions: [{ type: 'function', function: { name, parameters: { type: 'object' } } }], has: candidate => candidate === name, label: () => name, execute });

test('failed, unsatisfied and unexecuted local results stay failed in progress, trace and task settlement', async t => {
  for (const [label, value, name] of [
    ['returned failure', { ok: false, error: '失败证据' }, 'run_skill'],
    ['unmet wait', { ok: true, satisfied: false, note: '等待条件不满足' }, 'wait_for'],
    ['approved only', { ok: true, execution_status: 'not_executed' }, 'click'],
    ['failed receipt', { ok: true, receipt: { status: 'failed' } }, 'read_text'],
    ['unchanged action', { ok: true, changed: false }, 'click'],
  ]) await t.test(label, () => withModelServer((_body, turn) => ({ message: turn === 1 ? proposedTool(name) : { role: 'assistant', content: '模型声称完成' } }), async (base, requests) => {
    const events = [], commands = [];
    const result = await runAssistant({ ...base, localTools: fixtureTools(name, async () => value), core: fixtureCore(commands), progress: event => events.push(event) });
    assert.equal(result.trace[0].ok, false);
    assert.equal(events.find(event => event.phase === 'settled' && event.operation === name).ok, false);
    assert.equal(commands.at(-1).status, 'failed');
    assert.equal(result.executionStatus, 'incomplete');
    assert.match(result.text, /尚未完成或核对/);
    assert.deepEqual(JSON.parse(requests.at(-1).messages.find(item => item.role === 'tool').content), value);
  }));
});

test('a nonthrowing failed core receipt and failed delegate are never reported as successful', async t => {
  await t.test('core receipt', () => withModelServer((_body, turn) => ({ message: turn === 1 ? proposedTool('read_file', { file_id: 'selected' }) : { role: 'assistant', content: '未能读取' } }), async base => {
    const events = [], commands = [];
    const result = await runAssistant({ ...base, coreTools: true, progress: event => events.push(event), core: async body => {
      commands.push(body); if (body.action === 'reserve_call') return { call: { id: 'call' } };
      if (body.action === 'tool') return { receipt: { status: 'denied' }, error: '文件访问被拒绝' };
      return {};
    } });
    assert.equal(result.trace[0].ok, false); assert.equal(events.at(-1).ok, false); assert.equal(commands.at(-1).status, 'failed');
  }));
  await t.test('delegate result', () => withModelServer((_body, turn) => ({ message: turn === 1 ? proposedTool('delegate', { task: '验证' }) : { role: 'assistant', content: '委派未完成' } }), async base => {
    const events = [], commands = [];
    const result = await runAssistant({ ...base, progress: event => events.push(event), localTools: fixtureTools('delegate', async () => ({ ok: false, status: 'failed', error: '子任务失败' })), core: fixtureCore(commands) });
    assert.equal(result.trace[0].ok, false); assert.equal(events.at(-1).ok, false); assert.equal(commands.at(-1).status, 'failed');
  }));
});

test('an unknown tool response stops further model or native calls and retains the trace for recovery', () => withModelServer(() => ({ message: proposedTool('click') }), async (base, requests) => {
  const events = [], commands = [];
  await assert.rejects(runAssistant({ ...base, progress: event => events.push(event), localTools: fixtureTools('click', async () => ({ ok: true, execution_status: 'unknown' })), core: fixtureCore(commands) }), error => {
    assert.equal(error.code, 'CORE_ACTION_UNCERTAIN'); assert.equal(error.recoverable, true); assert.equal(error.trace[0].ok, false); assert.equal(error.unresolvedSteps[0].status, 'unknown'); return true;
  });
  assert.equal(requests.length, 1); assert.equal(events.at(-1).ok, false); assert.equal(commands.at(-1).status, 'failed');
}));

test('an unrelated tool-schema rejection preserves tools and fails visibly instead of silently retrying as chat', () => withModelServer(() => ({ status: 400, body: { error: { message: 'Invalid schema for function read_text: parameters must be an object' } } }), async (base, requests) => {
  const commands = [];
  await assert.rejects(runAssistant({ ...base, core: fixtureCore(commands), localTools: fixtureTools('read_text', async () => ({})) }), error => error.code === 'MODEL_REQUEST_REJECTED' && error.execution_status === 'not_started' && error.recoverable);
  assert.equal(requests.length, 1); assert.ok(requests[0].tools?.length); assert.equal(commands.at(-1).status, 'failed');
}));

test('optional protocol compatibility keeps execution tools and persists across model turns', () => withModelServer((body, turn) => {
  if (body.parallel_tool_calls !== undefined) return { status: 400, body: { error: { message: 'Unknown parameter parallel_tool_calls is not supported' } } };
  return { message: turn === 2 ? proposedTool('read_text') : { role: 'assistant', content: '已读取' } };
}, async (base, requests) => {
  const commands = [];
  await runAssistant({ ...base, localTools: fixtureTools('read_text', async () => ({ ok: true, text: '真实内容' })), core: fixtureCore(commands) });
  assert.equal(requests.length, 3); assert.ok(requests.every(body => body.tools?.length));
  assert.equal(requests[1].parallel_tool_calls, undefined); assert.equal(requests[2].parallel_tool_calls, undefined);
}));

test('an explicitly requested token parameter migration preserves the tool protocol', () => withModelServer(body => {
  if (body.max_tokens !== undefined) return { status: 400, body: { error: { message: 'max_tokens is not supported; use max_completion_tokens instead' } } };
  return { message: { role: 'assistant', content: '兼容成功' } };
}, async (base, requests) => {
  const commands = [];
  const result = await runAssistant({ ...base, localTools: fixtureTools('read_text', async () => ({})), core: fixtureCore(commands) });
  assert.equal(result.text, '兼容成功'); assert.equal(requests.length, 2);
  assert.equal(requests[1].max_completion_tokens, 32000); assert.ok(requests[1].tools?.length);
}));

test('missing tool capability uses an eligible fallback service while retaining tools', () => withModelServer(body => body.model === 'fixture' ? { status: 400, body: { error: { message: 'Tool calling is not supported by this model' } } } : { message: { role: 'assistant', content: '备用服务保留执行能力' } }, async (base, requests) => {
  const commands = [], switched = [];
  const result = await runAssistant({ ...base, localTools: fixtureTools('read_text', async () => ({})), core: fixtureCore(commands), fallbacks: [{ name: '可执行服务', settings: { ...base.settings, model: 'fallback' }, apiKey: '' }], onFailover: event => switched.push(event) });
  assert.equal(result.model, 'fallback'); assert.equal(switched.length, 1);
  assert.deepEqual(requests.map(body => body.model), ['fixture', 'fallback']); assert.ok(requests.every(body => body.tools?.length));
}));

test('missing tool capability without a permitted fallback leaves a recoverable failure', () => withModelServer(() => ({ status: 422, body: { error: { message: 'tools are not available for this model' } } }), async (base, requests) => {
  const commands = [];
  await assert.rejects(runAssistant({ ...base, localTools: fixtureTools('read_text', async () => ({})), core: fixtureCore(commands) }), error => error.code === 'MODEL_TOOLS_UNSUPPORTED' && error.recoverable && error.execution_status === 'not_started');
  assert.equal(requests.length, 1); assert.equal(commands.at(-1).status, 'failed');
}));

test('dynamic discovered tool definitions are read again on the next executor turn', () => withModelServer((_body, turn) => ({ message: turn === 1 ? proposedTool('discover_tools') : { role: 'assistant', content: '已发现能力' } }), async (base, requests) => {
  let discovered = false; const commands = [];
  const localTools = { ...fixtureTools('discover_tools', async () => { discovered = true; return { ok: true }; }), get definitions() { return [{ type: 'function', function: { name: 'discover_tools', parameters: { type: 'object' } } }, ...(discovered ? [{ type: 'function', function: { name: 'write_document', parameters: { type: 'object' } } }] : [])]; } };
  await runAssistant({ ...base, localTools, core: fixtureCore(commands) });
  assert.ok(!requests[0].tools.some(tool => tool.function.name === 'write_document'));
  assert.ok(requests[1].tools.some(tool => tool.function.name === 'write_document'));
}));

test('compaction awaits durable checkpoint storage and storage failure cannot produce a successful checkpoint', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'checkpoint write fails' : 'checkpoint persisted before continuing', async () => {
    let executorTurns = 0, saved = false; const checkpointSeen = [];
    await withModelServer(body => {
      const summarizing = body.messages.at(-1).content?.startsWith('把下面这段工作过程压缩');
      if (summarizing) return { message: { role: 'assistant', content: '已执行六步；下一步是核对。' } };
      executorTurns++; checkpointSeen.push({ turn: executorTurns, saved });
      return { message: executorTurns <= 6 ? proposedTool('read_text', { path: 'fixture.txt' }, 's' + executorTurns) : { role: 'assistant', content: '已核对' } };
    }, async base => {
      const commands = [], progress = [];
      const operation = runAssistant({ ...base, compactAt: 100, maxTurns: 10, localTools: fixtureTools('read_text', async () => ({ ok: true, text: '已经读取的真实材料。'.repeat(60) })), core: fixtureCore(commands), progress: event => progress.push(event), onCompact: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (fail) throw new Error('checkpoint write failed'); saved = true;
      } });
      if (fail) {
        await assert.rejects(operation, error => error.code === 'CHECKPOINT_PERSIST_FAILED' && error.recoverable);
        assert.equal(commands.at(-1).status, 'failed');
        assert.ok(!progress.some(event => event.operation === 'compact' && event.ok));
        assert.equal(executorTurns, 6);
      } else {
        await operation; assert.ok(progress.some(event => event.operation === 'compact' && event.ok));
        assert.equal(checkpointSeen.at(-1).saved, true);
      }
    });
  });
});

test('a later success only resolves the matching invocation, not a different file that happened to use the same tool', async t => {
  for (const sameFile of [false, true]) await t.test(sameFile ? 'same invocation recovered' : 'unrelated invocation still incomplete', () => {
    let executed = 0;
    return withModelServer((_body, turn) => ({ message: turn <= 2 ? proposedTool('read_text', { path: turn === 1 || sameFile ? 'missing.txt' : 'other.txt' }, 's' + turn) : { role: 'assistant', content: '已整理读取结果' } }), async base => {
      const commands = [];
      const result = await runAssistant({ ...base, localTools: fixtureTools('read_text', async () => ++executed === 1 ? { ok: false, error: '读取失败' } : { ok: true, text: '有效材料' }), core: fixtureCore(commands) });
      assert.equal(commands.at(-1).status, sameFile ? 'finished' : 'failed');
      assert.equal(result.executionStatus, sameFile ? 'settled' : 'incomplete');
      assert.deepEqual(result.trace.map(step => step.ok), [false, true]);
    });
  });
});

test('modelResponse transforms user messages with images into multimodal image_url payload', async () => {
  let capturedBody = null;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '我看到了一张图' } }], usage: { total_tokens: 15 } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const settings = { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'vision-model' };
    const messages = [
      {
        role: 'user',
        content: '这是什么图片？',
        images: ['data:image/png;base64,iVBORw0KGgo=']
      }
    ];
    const result = await modelResponse(settings, '', messages, 'verifier', AbortSignal.timeout(3000));
    assert.equal(result.message.content, '我看到了一张图');
    assert.ok(capturedBody);
    const userMsg = capturedBody.messages[0];
    assert.equal(userMsg.role, 'user');
    assert.ok(Array.isArray(userMsg.content));
    assert.deepEqual(userMsg.content, [
      { type: 'text', text: '这是什么图片？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});



test('executor text streams to the user, truncation is disclosed, and the model is told the current time', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ choices: [{ delta: { content: '第一段，' } }] }, { choices: [{ delta: { content: '第二段' }, finish_reason: 'length' }], usage: { total_tokens: 9 } }];
    res.end(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const emitted = [];
  try {
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'local-test' }, apiKey: '',
      work: { id: 'work', goal: 'write', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: 'write' }],
      signal: new AbortController().signal, emit: (text, reset) => emitted.push({ text, reset: !!reset }),
      core: async body => body.action === 'reserve_call' ? { call: { id: 'call' } } : body.action === 'finish' ? { work: {} } : {} });
    assert.deepEqual(emitted, [{ text: '', reset: true }, { text: '第一段，', reset: false }, { text: '第二段', reset: false }]);
    assert.equal(result.text, '第一段，第二段' + TRUNCATED_NOTICE);
    assert.equal(requests[0].max_tokens, 32000);
    assert.match(requests[0].messages[0].content, /"now":\{"iso":"\d{4}-/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a long streamed answer is not rejected because of per-chunk envelope overhead', async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let wire = '';
    for (let index = 0; index < 6000; index++) wire += 'data: ' + JSON.stringify({ id: 'chatcmpl-' + 'x'.repeat(30), object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '字' } }] }) + '\n\n';
    res.end(wire + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.ok(6000 * 150 > 400000, 'the raw stream exceeds the old limit');
    const result = await modelResponse({ endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, '', [{ role: 'user', content: 'x' }], 'executor', AbortSignal.timeout(10000));
    assert.equal(result.message.content.length, 6000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an oversized max_tokens is retried at a safe value, and an answer eaten by thinking is explained', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (body.max_tokens > 4096) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'max_tokens must be <= 4096' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想了很久' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm', maxTokens: 20000 }, apiKey: '',
      work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal, emit: () => {}, coreTools: false,
      core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : body.action === 'finish' ? { work: {} } : {} });
    // Halves until the provider accepts it; the one retry for an answer eaten by thinking asks for less thinking and never goes above a size the provider rejected.
    assert.deepEqual(requests.map(item => item.max_tokens), [20000, 10000, 5000, 4096, 4096]);
    assert.match(JSON.stringify(requests.at(-1).messages), /少思考/);
    assert.equal(result.text, THINKING_EXHAUSTED_NOTICE);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a screenshot returned by a tool reaches the model as an image, and only the newest one is kept', async () => {
  const requests = [];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
    turn++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: turn < 3 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c' + turn, type: 'function', function: { name: 'screenshot', arguments: '{"window":"x"}' } }] } : { role: 'assistant', content: '看到了' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localTools = { names: ['screenshot'], definitions: [], has: name => name === 'screenshot', label: () => '截图', execute: async () => ({ ok: true, image: 'data:image/jpeg;base64,AAAA' + turn, note: '坐标说明' }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '看看' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, localTools,
      core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} } });
    assert.equal(result.text, '看到了');
    const last = requests.at(-1).messages;
    const withImages = last.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    assert.equal(withImages.length, 1, 'only the latest screenshot stays in the request');
    assert.ok(last.some(message => message.content === '（较早的截图已省略）'));
    assert.ok(last.filter(message => message.role === 'tool').every(message => !message.content.includes('base64')), 'raw image data never rides inside a tool message');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a model that cannot see images keeps its tools: screenshots are dropped with an explanation', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const hasImage = JSON.stringify(body.messages).includes('image_url');
    if (hasImage) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'image_url is not supported by this model' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    const toolMessages = body.messages.filter(item => item.role === 'tool').length;
    res.end(JSON.stringify({ choices: [{ message: toolMessages === 0 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{"window":"x"}' } }] } : { role: 'assistant', content: '改用控件树' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localTools = { names: ['screenshot'], definitions: [{ type: 'function', function: { name: 'screenshot', parameters: { type: 'object' } } }], has: name => name === 'screenshot', label: () => '截图', execute: async () => ({ ok: true, image: 'data:image/jpeg;base64,AAAA' }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '看看' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, localTools,
      core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} } });
    assert.equal(result.text, '改用控件树');
    assert.ok(requests.at(-1).tools?.length, 'tools must still be offered after the image was dropped');
    assert.match(JSON.stringify(requests.at(-1).messages), /无法接收图片/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('when the core refuses further model calls (HTTP 409) a long local task keeps going instead of dying', async () => {
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    turn++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: turn < 4 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c' + turn, type: 'function', function: { name: 'update_plan', arguments: '{"steps":[{"text":"a","status":"doing"}]}' } }] } : { role: 'assistant', content: '全部完成' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const reserved = [];
  try {
    const localTools = { names: ['update_plan', 'screenshot'], definitions: [], has: name => name === 'update_plan', label: () => '计划', execute: async () => ({ ok: true }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '干活' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, localTools, maxTurns: 10,
      core: async body => {
        if (body.action === 'reserve_call') { reserved.push(1); if (reserved.length > 2) throw new Error('核心返回 HTTP 409'); return { call: { id: 'c' + reserved.length } }; }
        if (body.action === 'finish') throw new Error('核心返回 HTTP 409');
        return { work: {} };
      } });
    assert.equal(result.text, '全部完成');
    assert.equal(turn, 4);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('the working-method guide is only given to models that can actually drive software', async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} } };
    await runAssistant({ ...base, localTools: { names: ['screenshot'], definitions: [], has: () => true, label: () => '', execute: async () => ({}) } });
    await runAssistant({ ...base, localTools: { names: ['read_text'], definitions: [], has: () => false, label: () => '', execute: async () => ({}) } });
    assert.match(bodies[0].messages[0].content, /操作电脑软件/);
    assert.doesNotMatch(bodies[1].messages[0].content, /操作电脑软件/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
