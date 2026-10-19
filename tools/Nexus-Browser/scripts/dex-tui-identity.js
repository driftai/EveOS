'use strict';
// Presentation-only identity, never an authentication or target-selection key.
function displayName(value) {
  const name = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/ {2,}/g, ' ').trim().slice(0, 28).trim();
  return name || 'User';
}
function promptFor(value, mode) {
  return `${displayName(value)}/${mode === 'Base' ? 'Base' : 'Dex'}> `;
}
module.exports = { displayName, promptFor };
