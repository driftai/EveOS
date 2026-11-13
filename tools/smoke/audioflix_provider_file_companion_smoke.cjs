'use strict';
const fs=require('fs'),assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'../..');
const ui=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.provider.capture.ui.js'),'utf8');
assert(!ui.includes('provider-open-companion'));
assert(!ui.includes('Open Local Capture Companion'));
console.log('AUDIOFLIX_PROVIDER_FILE_COMPANION_RETIRED_OK no_companion_button=true');
