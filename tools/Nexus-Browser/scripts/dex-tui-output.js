'use strict';
// A view-only writer. Async provider updates may arrive while readline owns
// an unfinished input line; repaint that buffer without submitting it.
const readline = require('node:readline');
function createPromptOutput(output) {
  let active = null;
  return {
    attach(rl) { active = rl; },
    detach(rl) { if (active === rl) active = null; },
    write(value) {
      if (active && output.isTTY === true) {
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
      }
      output.write(`${value}\n`);
      if (active && output.isTTY === true) active.prompt(true);
    }
  };
}
module.exports = { createPromptOutput };
