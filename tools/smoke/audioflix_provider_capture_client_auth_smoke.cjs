'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'../..');
const src=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.native.provider-capture.js'),'utf8');
assert(src.includes("mode: isFile() ? 'cors' : 'same-origin'"));
assert(src.includes("headers['X-EveOS-Provider-File-Auth'] = await fileCredential()"));
assert(!src.includes('fileRpc('));
assert(src.includes("detail.endpoint.deviceId"));
assert(src.includes("deviceId.startsWith('sd:')"));
const context=vm.createContext({window:{},location:{protocol:'http:',origin:'http://127.0.0.1:8765'},URL,AbortController,setTimeout,clearTimeout});
vm.runInContext(src,context);
const classify=context.window.EveAudioflixNativeProviderCapture.responseError;
for(const [message,status,category,retryable] of [
  ['invalid or expired provider capture session',404,'session-expired',true],
  ['selected endpoint disappeared',409,'endpoint-unavailable',false],
  ['ownership authorization refused',403,'authorization',false],
  ['temporary bridge refusal',503,'bridge-refused',true]
]){const error=classify({message},status);assert.equal(error.eveCategory,category);assert.equal(error.eveRetryable,retryable);}
console.log('AUDIOFLIX_PROVIDER_CAPTURE_CLIENT_AUTH_OK same_origin=true direct_file_proof=true exact_native_endpoint=true categories=true');
