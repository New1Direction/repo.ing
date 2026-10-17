/** Injected only by the opt-in loopback runner; the public Playground never loads this module. */
import { createFlow, receiveState, invalidate, cancelReview, beginRequest, receiveReview, receiveResult, receiveRejection, unknown, readBoundedJson } from './max-wallet-flow-state.mjs';

const entry = document.querySelector('#max-wallet-local-open');
const token = document.querySelector('meta[name="hooklab-local-session"]')?.content;
const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
if (entry && token && loopback) mountLocalFlow(entry, token);

export function mountLocalFlow(openButton, sessionToken) {
  let flow = createFlow(), selected = 'prepare', opened = false, loading = false, activeController = null;
  let savedNodes = [], expiryTimer = null, expiryReviewId = null;
  const skipLink = document.querySelector('a.skip'), originalSkipTarget = skipLink?.getAttribute('href');
  openButton.setAttribute('aria-label', 'Open local max-wallet program test');
  openButton.setAttribute('title', 'Local max-wallet program test');
  openButton.setAttribute('aria-controls', 'max-wallet-local-workspace');
  const main = document.querySelector('main');
  if (!main) return;
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (key === 'hidden') node.hidden = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child != null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
  };
  const button = (id, label, handler, className = '') => el('button', { id, type: 'button', className, onClick: handler }, label);
  const heading = el('h1', { id: 'mw-title', tabindex: '-1' }, 'One policy.', el('span', {}, ' Test the whole flow.'));
  const back = button('mw-back', '← Back to simulation', close, 'quiet');
  const intro = el('section', { className: 'intro mw-intro' }, el('div', {}, el('div', { className: 'eyebrow' }, 'LOCAL PROGRAM TEST · MAX WALLET'), heading, el('p', {}, 'Prepare an explicit cap, launch, then test buys and sells against the program.')), back);
  const root = el('section', { id: 'max-wallet-local-workspace', className: 'mw-flow', hidden: true, 'aria-labelledby': 'mw-title' }, intro);
  const notice = el('div', { className: 'notice mw-notice' }, el('span', { className: 'mint', 'aria-hidden': 'true' }, '◈'), el('div', {}, el('strong', {}, 'Local program test. Synthetic liquidity. Signatures not verified. No real wallet.'), el('p', {}, 'Only the max-wallet candidate is exercised here. The six-module Playground remains a separate educational simulation. No signing, broadcasting, deployment, or production preparation receipt.')));
  const refresh = button('mw-refresh', 'Read current test state', refreshState);
  const statusText = el('span', { id: 'mw-status', role: 'status', 'aria-live': 'polite' }, 'Open the local test to read its state.');
  const stop = button('mw-stop-waiting', 'Stop waiting · lock execution', stopWaiting);
  stop.hidden = true;
  const statusbar = el('div', { className: 'toolbar mw-statusbar' }, el('div', { className: 'recipe-title' }, el('span', { className: 'status-dot' }), statusText), el('div', { className: 'toolbar-actions' }, refresh, stop));
  const error = el('div', { id: 'mw-error', className: 'validation mw-error', role: 'alert', tabindex: '-1', hidden: true });
  const library = el('aside', { className: 'library', 'aria-label': 'Local workflow steps' }, el('div', { className: 'section-label' }, 'TEST WORKFLOW', el('span', {}, '03')), el('p', { className: 'help' }, 'One candidate, three explicit steps.'));
  const stepNames = { prepare: 'Prepare policy', launch: 'Launch', trade: 'Buy / sell' };
  const stepCopy = { prepare: 'Set the immutable owner cap', launch: 'Create with the prepared policy', trade: 'Observe real local program outcomes' };
  const stepButtons = {}, nodes = {};
  for (const [i, key] of ['prepare', 'launch', 'trade'].entries()) {
    stepButtons[key] = button(`mw-step-${key}`, '', () => chooseStep(key), 'module-item');
    stepButtons[key].append(el('span', { className: 'mint', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')), el('span', {}, el('strong', {}, stepNames[key]), el('small', {}, stepCopy[key])), el('span', { 'aria-hidden': 'true' }, '→'));
    library.append(stepButtons[key]);
  }
  library.append(el('p', { className: 'library-note' }, 'Synthetic test identities come from this runner. Nothing is copied from your simulation draft or a production wallet.'));
  const phaseLabel = el('small', { id: 'mw-phase' }, 'State not read');
  const canvas = el('div', { className: 'canvas mw-canvas', 'aria-label': 'Max-wallet test progress' });
  for (const key of ['prepare', 'launch', 'trade']) {
    const label = el('small', {}, 'Not run');
    const node = button(`mw-node-${key}`, '', () => chooseStep(key), 'node off');
    node.append(el('span', { className: 'port', 'aria-hidden': 'true' }), el('span', { className: 'node-top' }, el('strong', {}, stepNames[key]), el('span', { className: 'node-tag' }, 'LOCAL')), label);
    nodes[key] = { node, label }; canvas.append(node);
  }
  const capSummary = el('div', { className: 'mw-cap-summary' });
  canvas.append(capSummary);
  const canvasSection = el('section', { className: 'canvas-section', 'aria-label': 'Local max-wallet flow' }, el('div', { className: 'canvas-heading' }, el('span', {}, el('strong', {}, 'Your local launch flow'), phaseLabel), el('span', { className: 'badge live' }, 'SBF PROGRAM')), canvas, el('div', { className: 'canvas-legend' }, 'Only matching program responses advance this flow.'));
  const inspectorTitle = el('h2', { id: 'mw-inspector-title', tabindex: '-1' }, 'Prepare policy');
  const inspector = el('aside', { className: 'inspector mw-inspector', 'aria-labelledby': 'mw-inspector-title' }, el('div', { className: 'section-label' }, 'EXPLICIT LOCAL INPUTS'), inspectorTitle);
  const forms = {}, inputs = {};
  function field(id, label, description, options = {}) {
    const input = el('input', { id, name: id, type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help`, ...options });
    input.value = '';
    inputs[id] = input;
    input.addEventListener('input', edited);
    return el('div', { className: 'field mw-field' }, el('label', { for: id }, label), input, el('small', { id: `${id}-help` }, description));
  }
  const prepare = el('form', { id: 'mw-prepare-form', novalidate: '' }, el('p', { className: 'mw-form-copy' }, 'The cap is explicit and fixed against initial supply. 100 basis points equals 1%; no value is preselected.'), field('mw-cap-bps', 'Wallet cap (basis points)', 'Whole number from 1 to 9999. No default percentage.', { inputmode: 'numeric' }), field('mw-label', 'Policy label', 'Required, at most 32 UTF-8 bytes.', { maxlength: '32' }));
  const prepareReview = button('mw-review-prepare', 'Review preparation', () => requestReview('prepare'), 'primary module-action');
  prepare.append(prepareReview); forms.prepare = prepare;
  const launch = el('form', { id: 'mw-launch-form', novalidate: '' }, el('p', { className: 'mw-form-copy' }, 'Launch uses only the policy and exact test identities shown below.'), field('mw-name', 'Token name', 'Required, at most 32 UTF-8 bytes.', { maxlength: '32' }), field('mw-symbol', 'Symbol', 'Required, at most 10 UTF-8 bytes.', { maxlength: '10' }), field('mw-uri', 'Metadata URI', 'At most 200 UTF-8 bytes. Leave blank deliberately for no URI; no metadata is fetched.', { maxlength: '200' }), field('mw-virtual-quote', 'Virtual quote reserve (raw units)', 'Required positive whole raw-unit amount. The runner checks the test configuration bounds.', { inputmode: 'numeric' }));
  const launchReview = button('mw-review-launch', 'Review launch', () => requestReview('launch'), 'primary module-action');
  launch.append(launchReview); forms.launch = launch;
  const direction = el('select', { id: 'mw-direction', 'aria-describedby': 'mw-direction-help' }, el('option', { value: 'buy' }, 'Buy base with quote'), el('option', { value: 'sell' }, 'Sell base for quote'));
  direction.addEventListener('change', edited);
  const quoteText = el('div', { id: 'mw-quote', className: 'mw-quote', 'aria-live': 'polite' }, 'No current quote.');
  const trade = el('form', { id: 'mw-trade-form', novalidate: '' }, el('p', { className: 'mw-form-copy' }, 'Enter both amounts, get a quote, then review the exact message. Program failures remain visible with actual test balances.'), el('div', { className: 'field mw-field' }, el('label', { for: 'mw-direction' }, 'Direction'), direction, el('small', { id: 'mw-direction-help' }, 'Raw units only; this is synthetic test liquidity.')), field('mw-amount-in', 'Input amount (raw units)', 'Required positive whole amount. Buy spends quote; sell spends base.', { inputmode: 'numeric' }), field('mw-min-out', 'Minimum output (raw units)', 'Explicit positive minimum for execution. A quote uses minimum 0 only as a non-executing calculation.', { inputmode: 'numeric' }), quoteText);
  const quoteButton = button('mw-get-quote', 'Get non-executing quote', requestQuote, 'module-action');
  const tradeReview = button('mw-review-trade', 'Review trade', () => requestReview(direction.value), 'primary module-action');
  trade.append(quoteButton, tradeReview, el('p', { className: 'mini-note' }, 'The review expires offchain. This swap ABI has no onchain deadline or economics guard. A quote is not an execution guarantee.'));
  forms.trade = trade;
  for (const form of Object.values(forms)) { form.addEventListener('submit', event => event.preventDefault()); inspector.append(form); }
  const reviewTitle = el('h3', { tabindex: '-1', id: 'mw-review-title' }, 'Exact unsigned message review');
  const reviewDetails = el('dl', { className: 'mw-details', id: 'mw-review-details' });
  const execute = button('mw-execute', 'Execute in local program test', executeReviewed, 'primary module-action');
  const cancel = button('mw-cancel-review', 'Cancel this review', () => { flow = cancelReview(flow); render(); inspectorTitle.focus(); }, 'module-action');
  const reviewPanel = el('section', { id: 'mw-review-panel', className: 'mw-review-panel', hidden: true, 'aria-labelledby': 'mw-review-title' }, reviewTitle, reviewDetails, el('p', { className: 'mini-note' }, 'Unsigned exact message; required signer identities are displayed for inspection only. This isolated VM does not verify signatures. No real wallet is requested.'), execute, cancel);
  inspector.append(reviewPanel);
  const workspace = el('div', { className: 'workspace mw-workspace' }, library, canvasSection, inspector);
  const balanceBase = el('strong', { id: 'mw-balance-base' }, '—');
  const balanceQuote = el('strong', { id: 'mw-balance-quote' }, '—');
  const identities = el('dl', { id: 'mw-identities', className: 'mw-details' });
  const stateNotice = el('p', { id: 'mw-server-notice', className: 'mw-form-copy' });
  const pauseButton = button('mw-toggle-pause', 'Pause local test pool', togglePause);
  const pauseNote = el('p', { className: 'mini-note' }, 'Pause is a synthetic test control, not a signed transaction. It lets you inspect paused-pool program failures when supported.');
  const records = el('ol', { id: 'mw-receipts', className: 'mw-receipts' });
  const receiptEmpty = el('p', { id: 'mw-no-receipts', className: 'muted' }, 'No local program executions in this view. Quotes and reviews are not receipts.');
  root.append(notice, statusbar, error, workspace, el('section', { className: 'simulation', 'aria-labelledby': 'mw-evidence-title' }, el('div', { className: 'sim-heading' }, el('div', {}, el('div', { className: 'eyebrow' }, 'OBSERVED LOCAL EVIDENCE'), el('h2', { id: 'mw-evidence-title' }, 'Test balances & identity'))), el('div', { className: 'sim-layout mw-evidence-layout' }, el('div', { className: 'chart-panel' }, el('div', { className: 'mw-balances' }, el('div', { className: 'metric' }, el('span', { className: 'metric-label' }, 'Trader base · raw'), balanceBase), el('div', { className: 'metric' }, el('span', { className: 'metric-label' }, 'Trader quote · raw'), balanceQuote)), pauseButton, pauseNote, stateNotice), el('div', { className: 'mw-identity-panel' }, el('h3', {}, 'Original public test identities'), identities))), el('section', { className: 'simulation mw-outcomes', 'aria-labelledby': 'mw-outcomes-title' }, el('h2', { id: 'mw-outcomes-title' }, 'Local program outcomes'), receiptEmpty, records));
  main.append(root);
  openButton.addEventListener('click', open);
  function chooseStep(step, focus = true) { if (flow.pending) return; selected = step; render(); if (focus) inspectorTitle.focus(); }
  function open() {
    if (opened) return;
    opened = true;
    savedNodes = [...main.children].filter(node => node !== root).map(node => ({ node, hidden: node.hidden }));
    for (const node of document.querySelectorAll('.header #boundary, .header > .badge')) savedNodes.push({ node, hidden: node.hidden });
    for (const item of savedNodes) item.node.hidden = true;
    root.hidden = false; if (skipLink) skipLink.setAttribute('href', '#mw-inspector-title'); openButton.setAttribute('aria-expanded', 'true'); heading.focus();
    if (!flow.server && !flow.locked) refreshState(); else render();
  }
  function close() {
    if (flow.pending || loading) return;
    flow = cancelReview(flow);
    for (const item of savedNodes) item.node.hidden = item.hidden;
    root.hidden = true; if (skipLink && originalSkipTarget) skipLink.setAttribute('href', originalSkipTarget); opened = false; openButton.setAttribute('aria-expanded', 'false'); openButton.focus();
  }
  function edited() { if (flow.pending) return; flow = invalidate(flow); render(); }
  function inputFor(action) {
    if (action === 'prepare') {
      const raw = inputs['mw-cap-bps'].value;
      if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new Error('Enter an explicit wallet cap from 1 to 9999 basis points.');
      return { capBps: Number(raw), label: inputs['mw-label'].value };
    }
    if (action === 'launch') return { name: inputs['mw-name'].value, symbol: inputs['mw-symbol'].value, uri: inputs['mw-uri'].value, virtualQuote: inputs['mw-virtual-quote'].value };
    return { direction: direction.value, amountInRaw: inputs['mw-amount-in'].value, minAmountOutRaw: action === 'quote' ? '0' : inputs['mw-min-out'].value };
  }
  function showInputError(problem) { flow = invalidate(flow, problem.message); render(); error.focus(); }
  async function refreshState() {
    if (flow.pending || loading) return;
    loading = true; render();
    const controller = new AbortController(); activeController = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/__local/max-wallet/state', { method: 'GET', headers: { 'X-Hooklab-Local': sessionToken }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status !== 200) throw new Error(`Local test state unavailable (HTTP ${response.status}).`);
      const data = await readBoundedJson(response); flow = receiveState(flow, data);
      if (flow.server.phase === 'prepared') selected = 'launch';
      else if (['launched', 'paused'].includes(flow.server.phase)) selected = 'trade';
    } catch (problem) { flow = { ...flow, review: null, quote: null, status: flow.locked ? 'uncertain' : 'unavailable', error: `State was not accepted: ${problem.message}` }; }
    finally { clearTimeout(timer); loading = false; if (activeController === controller) activeController = null; render(); if (flow.error && opened) error.focus(); }
  }
  function requestReview(action) { try { send('review', action, inputFor(action)); } catch (problem) { showInputError(problem); } }
  function requestQuote() { try { send('quote', 'quote', inputFor('quote')); } catch (problem) { showInputError(problem); } }
  function executeReviewed() { if (flow.review) send('action', flow.review.action, flow.review.input); }
  function togglePause() { if (flow.server) send('action', 'pause', { paused: flow.server.phase !== 'paused' }); }
  async function send(kind, action, input) {
    let request;
    try { request = beginRequest(flow, kind, action, input, crypto.randomUUID()); }
    catch (problem) { showInputError(problem); return; }
    flow = request.flow; render();
    const controller = new AbortController(); activeController = controller;
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`/__local/max-wallet/${kind === 'review' ? 'review' : 'action'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hooklab-Local': sessionToken }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify(request.envelope), signal: controller.signal });
      const value = await readBoundedJson(response);
      if (flow.pending?.requestId !== request.envelope.requestId) return;
      if ([409, 422].includes(response.status)) flow = receiveRejection(flow, value, response.status);
      else if (response.status !== 200) flow = unknown(flow, `Local runner returned HTTP ${response.status}. The outcome is unconfirmed; further execution is locked.`);
      else flow = kind === 'review' ? receiveReview(flow, value) : receiveResult(flow, value, response.status);
      if (flow.status === 'succeeded' && action === 'prepare') selected = 'launch';
      if (flow.status === 'succeeded' && action === 'launch') selected = 'trade';
    } catch (problem) { if (flow.pending?.requestId === request.envelope.requestId) flow = unknown(flow, `Response was not confirmed: ${problem.message}. Further execution is locked; no retry was sent.`); }
    finally {
      clearTimeout(timer); if (activeController === controller) activeController = null; render();
      if (opened) { if (flow.error) error.focus(); else if (flow.review) reviewTitle.focus(); else if (flow.status === 'succeeded') inspectorTitle.focus(); }
    }
  }
  function stopWaiting() {
    if (!flow.pending) return;
    flow = unknown(flow, 'Stopped waiting. This does not cancel server execution. The outcome is unknown, so further execution is locked.');
    activeController?.abort(); render(); error.focus();
  }
  function definition(list, label, value) { list.append(el('dt', {}, label), el('dd', {}, value)); }
  function render() {
    const state = flow.server, busy = !!flow.pending || loading, disabled = busy || flow.locked || !state || flow.status === 'stale' || flow.status === 'unavailable';
    const statusLabels = { idle: 'Not connected', ready: 'Ready for explicit inputs', pending: `${flow.pending?.kind === 'review' ? 'Building exact message review' : flow.pending?.kind === 'quote' ? 'Calculating non-executing quote' : 'Running local action'}…`, reviewed: 'Exact message ready for review', quoted: 'Quote received · no execution', succeeded: 'Local program action succeeded', 'program-failed': 'Program rejected the exact message', uncertain: 'Unconfirmed outcome · execution locked', stale: 'State changed · explicit refresh required', invalid: 'Input or review not accepted', cancelled: 'Review cancelled · no new request', unavailable: 'Local state unavailable' };
    statusText.textContent = loading ? 'Reading local test state…' : `${statusLabels[flow.status] || 'Unknown state'}${state ? ` · revision ${state.revision}` : ''}`;
    error.hidden = !flow.error; error.textContent = flow.error + (flow.locked ? ' Restart this isolated runner and reload the page to start a new test; a state refresh cannot unlock an unconfirmed execution.' : '');
    const currentReviewId = !busy ? flow.review?.reviewId ?? null : null;
    if (currentReviewId !== expiryReviewId) {
      clearTimeout(expiryTimer); expiryReviewId = currentReviewId;
      if (currentReviewId) expiryTimer = setTimeout(() => {
        if (!flow.pending && flow.review?.reviewId === currentReviewId) {
          flow = invalidate(flow, 'Exact message review expired. Get a fresh quote for a trade, then review again.'); render();
        }
      }, Math.max(0, flow.review.expiresAtMs - Date.now()) + 1);
    }
    root.setAttribute('aria-busy', busy ? 'true' : 'false'); back.disabled = busy; refresh.disabled = busy; stop.hidden = !flow.pending;
    for (const input of Object.values(inputs)) input.disabled = busy || flow.locked;
    direction.disabled = busy || flow.locked;
    inspectorTitle.textContent = stepNames[selected];
    for (const key of ['prepare', 'launch', 'trade']) {
      forms[key].hidden = selected !== key;
      const active = selected === key;
      stepButtons[key].setAttribute('aria-current', active ? 'step' : 'false'); stepButtons[key].disabled = busy;
      nodes[key].node.className = `node ${active ? 'selected' : ''}`; nodes[key].node.disabled = busy;
    }
    const prepared = !!state && ['prepared', 'launched', 'paused'].includes(state.phase);
    const launched = !!state && ['launched', 'paused'].includes(state.phase);
    nodes.prepare.label.textContent = prepared ? `Prepared · cap ${state.policy.capBps} bps` : 'Awaiting explicit policy';
    nodes.launch.label.textContent = launched ? 'Launched in the local program' : 'Awaiting prepared policy';
    const tradeCount = flow.receipts.filter(receipt => ['buy', 'sell'].includes(receipt.action) && receipt.outcome === 'succeeded').length;
    nodes.trade.label.textContent = tradeCount ? `${tradeCount} successful local trade${tradeCount === 1 ? '' : 's'}` : launched ? 'Ready for an explicit trade' : 'Awaiting launch';
    for (const [key, done] of [['prepare', prepared], ['launch', launched], ['trade', tradeCount > 0]]) { nodes[key].node.classList.toggle('off', !done); stepButtons[key].classList.toggle('connected', done); }
    phaseLabel.textContent = state ? `${state.phase} · synthetic-sbf` : 'No accepted state';
    capSummary.replaceChildren();
    capSummary.append(el('span', { className: 'eyebrow' }, 'OWNER CAP · INITIAL SUPPLY'), el('strong', {}, prepared ? `${state.policy.rawCap} raw tokens` : 'No cap chosen'), el('small', {}, state ? `Initial supply: ${state.policy.initialSupply} raw. Only server-acknowledged policy is shown.` : 'Enter a cap explicitly in the inspector.'));
    prepareReview.disabled = disabled || !state?.supportedActions.includes('prepare');
    launchReview.disabled = disabled || !state?.supportedActions.includes('launch');
    quoteButton.disabled = disabled || !state?.supportedActions.includes('quote');
    tradeReview.disabled = disabled || !flow.quote || !state?.supportedActions.includes(direction.value);
    if (flow.quote) quoteText.textContent = `${flow.quote.direction === 'buy' ? 'Base' : 'Quote'} output: ${flow.quote.amountOutRaw} raw · state revision ${flow.quote.revision}. Quote request ${flow.quote.requestId}. Not an execution.`;
    else quoteText.textContent = 'No current quote. Editing any field invalidates the quote and review.';
    reviewPanel.hidden = !flow.review;
    reviewDetails.replaceChildren();
    if (flow.review) {
      for (const [label, value] of [['Action', flow.review.action], ['State revision', flow.review.revision], ['Exact message SHA-256', flow.review.messageSha256], ['Wire bytes', flow.review.wireBytes], ['Review ID', flow.review.reviewId], ['Required test signer identities', flow.review.requiredSigners.join('\n')], ['Offchain review expires', new Date(flow.review.expiresAtMs).toISOString()]]) definition(reviewDetails, label, String(value));
      for (const [label, value] of Object.entries(flow.review.input)) definition(reviewDetails, label, String(value));
    }
    execute.disabled = disabled || !flow.review || flow.review.expiresAtMs <= Date.now(); cancel.disabled = busy;
    balanceBase.textContent = state?.balances.traderBaseRaw ?? '—'; balanceQuote.textContent = state?.balances.traderQuoteRaw ?? '—';
    identities.replaceChildren();
    if (state) {
      for (const [label, value] of Object.entries(state.identities)) definition(identities, label, value);
      definition(identities, 'Session', state.sessionId); definition(identities, 'Profile SHA-256', state.profileSha256);
    } else definition(identities, 'Test identity', 'Not loaded');
    stateNotice.textContent = state?.notice || 'No local state has been accepted.';
    pauseButton.textContent = state?.phase === 'paused' ? 'Resume local test pool' : 'Pause local test pool';
    pauseButton.disabled = disabled || !state?.supportedActions.includes('pause');
    receiptEmpty.hidden = flow.receipts.length > 0; records.replaceChildren();
    for (const receipt of [...flow.receipts].reverse()) {
      const details = el('dl', { className: 'mw-details' });
      for (const [label, value] of [['Request', receipt.requestId], ['Revision', receipt.state.revision], ['Message SHA-256', receipt.messageSha256 ?? 'No message: synthetic test control'], ['Trader base · raw', receipt.state.balances.traderBaseRaw], ['Trader quote · raw', receipt.state.balances.traderQuoteRaw]]) definition(details, label, String(value));
      records.append(el('li', { className: `mw-receipt ${receipt.outcome === 'program-failed' ? 'mw-failed' : ''}` }, el('h3', {}, `${receipt.action} · ${receipt.outcome === 'succeeded' ? 'local success' : 'program failure'}`), receipt.error ? el('p', { className: 'mw-program-error' }, receipt.error) : null, details));
    }
  }
  render();
  return { open, close };
}
