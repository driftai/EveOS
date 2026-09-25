'use strict';
const METHODS = Object.freeze({
  arm_post_idle: 'arm',
  post_idle_status: 'status',
  cancel_post_idle: 'cancel',
  report_post_idle: 'report'
});
function runPostIdleCommand(maintenance, action, source, command) {
  if (!maintenance) return {
    ok: false, code: 'POST_IDLE_UNAVAILABLE',
    message: 'Post-idle handoff is unavailable.'
  };
  const method = METHODS[action];
  if (!method || typeof maintenance[method] !== 'function') return {
    ok: false, code: 'POST_IDLE_BAD_ACTION',
    message: 'Unsupported post-idle control action.'
  };
  try { return maintenance[method]({ source, command }); }
  catch (error) { return {
    ok: false, code: 'POST_IDLE_INTERNAL',
    message: String(error?.message || error).slice(0, 180)
  }; }
}
module.exports = { METHODS, runPostIdleCommand };
