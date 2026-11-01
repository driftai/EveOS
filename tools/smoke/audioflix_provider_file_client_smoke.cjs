'use strict';
const fs=require('fs'),assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'../..');
const capture=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.provider.capture.js'),'utf8');
const native=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.native.provider-capture.js'),'utf8');
assert(!capture.includes('requireFileCompanion?.()'));
assert(!native.includes('window.open('));
assert(native.includes('fileCredential()'));
console.log('AUDIOFLIX_PROVIDER_FILE_CLIENT_OK direct=true no_companion=true');
