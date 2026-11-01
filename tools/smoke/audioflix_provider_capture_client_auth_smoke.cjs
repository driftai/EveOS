'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');
const src=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.native.provider-capture.js'),'utf8');
assert(src.includes("mode: isFile() ? 'cors' : 'same-origin'"));
assert(src.includes("headers['X-EveOS-Provider-File-Auth'] = await fileCredential()"));
assert(!src.includes('fileRpc('));
console.log('AUDIOFLIX_PROVIDER_CAPTURE_CLIENT_AUTH_OK same_origin=true direct_file_proof=true');
