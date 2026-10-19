// Runs in an isolated Chromium world. No page-provided script or model-supplied JavaScript is executed.
// Element handles are scoped to one observation. A navigation, UI action or a second observer invalidates them.
function pageOperation(operation, args, key) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const roots = [document];
  const all = [];
  for (let i = 0; i < roots.length && i < 80; i++) {
    for (const node of roots[i].querySelectorAll('*')) {
      all.push(node);
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.tagName === 'IFRAME') { try { if (node.contentDocument) roots.push(node.contentDocument); } catch {} }
      if (all.length >= 16000) break;
    }
    if (all.length >= 16000) break;
  }
  const visible = node => { const r = node.getBoundingClientRect(), style = node.ownerDocument.defaultView.getComputedStyle(node); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const label = node => clean(node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.getAttribute('alt') || node.innerText || node.textContent || node.getAttribute('title')).slice(0, 180);
  const fingerprint = node => JSON.stringify([node.tagName, node.getAttribute('type'), node.getAttribute('name'), node.getAttribute('href'), label(node)]);
  if (operation === 'observe') {
    const handles = new Map(), elements = [], writingContent = [];
    let writingBudget = 100000;
    for (const node of all) {
      if (!node.matches('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="tab"],[contenteditable]:not([contenteditable="false"]),summary') || !visible(node)) continue;
      const id = elements.length + 1; handles.set(id, { node, fingerprint: fingerprint(node) });
      const password = node.matches('input[type="password"]') || /password|cc-number|cc-csc/.test(node.getAttribute('autocomplete') || '');
      if (!password && node.matches('textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) {
        const fullText = String(node.value ?? node.innerText ?? node.textContent ?? '');
        writingContent.push({ id, text: fullText.slice(0, writingBudget), truncated: fullText.length > writingBudget });
        writingBudget = Math.max(0, writingBudget - fullText.length);
      }
      elements.push({ id, tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || '', name: label(node), text: clean(node.innerText || node.textContent).slice(0, 180), type: node.getAttribute('type') || '', disabled: !!node.disabled, ...(password ? { sensitive: true } : { value: clean(node.value).slice(0, 180) }), ...(node.tagName === 'SELECT' ? { options: [...node.options].slice(0, 80).map(item => ({ label: item.label, value: item.value })) } : {}) });
      if (elements.length >= 300) break;
    }
    // External isolated worlds do not always expose Web Crypto. The trusted host supplies each fresh ID.
    const documentId = args.observationId || crypto.randomUUID(); globalThis[key] = { documentId, handles };
    const extraText = roots.slice(1).map(root => root.body?.innerText || [...root.querySelectorAll('*')].filter(node => !node.children.length && visible(node) && !node.matches('script,style')).map(node => node.textContent).join(' '));
    const fullPageText = clean([document.body?.innerText, ...extraText].join(' '));
    const textLimit = args.maxChars || 16000, textTruncated = fullPageText.length > textLimit;
    return { documentId, url: location.href, title: document.title, text: fullPageText.slice(0, textLimit), textTruncated, writingContent, elements, truncated: textTruncated || elements.length >= 300 || all.length >= 16000, frames: all.filter(node => node.tagName === 'IFRAME').slice(0, 20).map(node => ({ title: node.title, src: node.src, accessible: !!node.contentDocument })), viewport: { width: innerWidth, height: innerHeight }, ready: document.readyState };
  }
  if (operation === 'probe') return { url: location.href, ready: document.readyState, viewport: { width: innerWidth, height: innerHeight }, found: args.text ? clean(document.body?.innerText).includes(clean(args.text)) : args.selector ? roots.some(root => { try { return [...root.querySelectorAll(args.selector)].some(visible); } catch { return false; } }) : document.readyState !== 'loading' };
  const state = globalThis[key];
  if (!state || !args.documentId || state.documentId !== args.documentId) throw new Error('页面观察已过期，请先 browser_observe 并使用新的 documentId 和元素编号');
  const handle = state.handles.get(args.element), node = handle?.node;
  if (!node || !node.isConnected || !visible(node) || handle.fingerprint !== fingerprint(node)) throw new Error('目标元素已变化或消失，请重新观察后选择');
  if (node.disabled || node.getAttribute('aria-disabled') === 'true') throw new Error('目标元素当前不可操作');
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (operation === 'target') {
    let rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, doc = node.ownerDocument;
    const composedContains = (parent, child) => { for (let item = child; item; item = item.parentElement || item.getRootNode()?.host) if (item === parent) return true; return false; };
    const top = doc.elementFromPoint(x, y);
    if (top && !composedContains(top, node) && !composedContains(node, top)) throw new Error('目标被其他内容遮挡，请先处理弹窗或重新观察');
    while (doc.defaultView.frameElement) { const frame = doc.defaultView.frameElement, r = frame.getBoundingClientRect(); x += r.x + frame.clientLeft; y += r.y + frame.clientTop; doc = frame.ownerDocument; const hit = doc.elementFromPoint(x, y); if (hit && !composedContains(hit, frame) && !composedContains(frame, hit)) throw new Error('子页面被其他内容遮挡，请先处理弹窗'); }
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) throw new Error('目标在可见区域外，请滚动后重新观察');
    if (args.focus) node.focus(); return { x, y, tag: node.tagName.toLowerCase(), type: node.type || '', editable: node.isContentEditable, sensitive: node.type === 'password' };
  }
  if (operation === 'select' || operation === 'validateSelect') {
    if (node.tagName !== 'SELECT') throw new Error('该元素不是下拉选择框');
    const values = args.values || [];
    if (!values.length || !node.multiple && values.length > 1 || values.some(value => ![...node.options].some(option => option.value === value && !option.disabled))) throw new Error('选项不存在或不能选择，请使用观察结果里的 option.value');
    if (operation === 'validateSelect') return { valid: true };
    for (const option of node.options) option.selected = values.includes(option.value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: [...node.selectedOptions].map(option => option.value) };
  }
  if (operation === 'uploadTarget') { if (node.tagName !== 'INPUT' || node.type !== 'file') throw new Error('该元素不是文件选择框'); return node; }
  throw new Error('未知网页操作');
}
module.exports = { pageOperation };
