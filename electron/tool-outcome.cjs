// A delivered tool response is not evidence that its requested result succeeded.
// Share these rules between execution traces and any host that records observations.
const UNKNOWN = new Set(['unknown', 'result_unknown', 'observed_unknown', 'uncertain', 'in_flight', 'running', 'pending']);
const NOT_EXECUTED = new Set(['not_executed', 'not_started', 'approved', 'awaiting_approval', 'pending_approval', 'requires_confirmation']);
const FAILED = new Set(['failed', 'observed_failure', 'error', 'denied', 'rejected', 'rejected_by_user', 'cancelled', 'cancel_requested', 'condition_unmet', 'postcondition_failed', 'timeout', 'timed_out', 'blocked', 'partial', 'incomplete']);
const CHANGE_ACTIONS = new Set(['click', 'drag', 'scroll', 'press_keys', 'type_text', 'uia_invoke', 'uia_set_value', 'click_text']);

function classifyToolOutcome(value, operation = '') {
  const response = value && typeof value === 'object' ? value : null;
  const statuses = [response?.execution_status, response?.status, response?.receipt?.status].filter(item => typeof item === 'string').map(item => item.toLowerCase());
  let status = 'succeeded';
  if (!response || statuses.some(item => UNKNOWN.has(item))) status = 'unknown';
  else if (statuses.some(item => NOT_EXECUTED.has(item))) status = 'not_executed';
  else if (response.ok === false || statuses.some(item => FAILED.has(item)) || response.error) status = 'failed';
  else if (response.satisfied === false || response.verified === false || response.verification?.passed === false || response.postcondition?.satisfied === false || (CHANGE_ACTIONS.has(operation) && response.changed === false)) status = 'condition_unmet';
  const ok = status === 'succeeded';
  const error = ok ? undefined : String(response?.error || response?.note || (status === 'unknown' ? '执行结果未知，需要先核对实际状态' : status === 'not_executed' ? '动作尚未执行' : status === 'condition_unmet' ? '工具返回的后置条件未满足' : '工具返回失败'));
  return { ok, status, ...(error ? { error } : {}), ...(ok ? {} : { recoverable: true }) };
}

module.exports = { classifyToolOutcome };
