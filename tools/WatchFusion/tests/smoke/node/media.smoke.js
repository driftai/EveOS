import assert from 'node:assert/strict';
import { classifyMediaUrl } from '../../../src/server/media-resolver.js';
import { findMediaProvider, listMediaProviders } from '../../../src/server/media-provider-registry.js';
import { directMediaProvider } from '../../../src/server/direct-media-provider.js';
import { startServer } from '../helpers/server-harness.js';
import { assertPublicHttpUrl } from '../../../src/server/public-url.js';
import { createRoom, joinRoom, request } from '../helpers/http-client.js';

const PORT = 19187;

export async function runMediaSmokes() {
  const results=[];
  const record=async(id,fn)=>{try{await fn();results.push({id,status:'PASS'});}catch(error){results.push({id,status:'FAIL',error:error.message});}};
  const server=await startServer({port:PORT,host:'127.0.0.1'});
  const baseUrl=server.baseUrl;
  try {
    await record('MEDIA-01:classify-direct-hls',async()=>{
      assert.deepEqual(classifyMediaUrl('https://example.com/master.m3u8?token=abc'),{kind:'hls',url:'https://example.com/master.m3u8?token=abc'});
    });
    await record('MEDIA-02:reject-invalid-scheme-and-embedded-credentials',async()=>{
      assert.equal(classifyMediaUrl('javascript:alert(1)'),null);assert.equal(classifyMediaUrl('not-a-url'),null);assert.equal(classifyMediaUrl('https://user:pass@example.com/video.m3u8'),null);
    });
    await record('MEDIA-03:provider-registry-separates-direct-and-page',async()=>{
      assert.deepEqual(listMediaProviders(),['direct-media','youtube','nuvio','browser-page']);assert.equal(findMediaProvider('https://example.com/watch/episode-1')?.id,'browser-page');assert.equal(findMediaProvider('https://cdn.example.com/episode/master.m3u8')?.id,'direct-media');assert.equal(findMediaProvider('not-a-url'),null);
    });
    await record('MEDIA-04:direct-provider-returns-source-without-discovery',async()=>{
      const result=await directMediaProvider.resolve('https://cdn.example.com/episode/master.m3u8?sig=test');assert.equal(result.ok,true);assert.equal(result.results[0].type,'hls');assert.equal(result.results[0].url,'https://cdn.example.com/episode/master.m3u8?sig=test');assert.equal(result.message,'Direct media URL accepted without page discovery.');
    });
    await record('MEDIA-05:public-url-guard-rejects-private-special-and-credentialed-targets',async()=>{
      for(const value of ['http://127.0.0.1/private','http://10.0.0.5/private','http://100.64.0.1/private','http://169.254.1.1/private','http://172.16.0.5/private','http://192.0.0.8/private','http://192.168.1.1/private','http://198.18.0.1/private','http://198.51.100.1/private','http://203.0.113.1/private','http://[::1]/private','http://[fd00::1]/private','http://[fe80::1]/private','http://user:pass@example.com/private']) await assert.rejects(()=>assertPublicHttpUrl(value));
      assert.equal(await assertPublicHttpUrl('https://8.8.8.8/media.m3u8'),'https://8.8.8.8/media.m3u8');
    });
    await record('MEDIA-06:resolver-requires-existing-room',async()=>{
      const response=await request(baseUrl,'/api/media/resolve',{method:'POST',headers:{'Content-Type':'application/json','x-member-id':'missing-member'},body:JSON.stringify({roomId:'MISSING',url:'https://example.com/watch/episode-1'})});assert.equal(response.status,404);assert.equal(response.json.code,'ROOM_NOT_FOUND');
    });
    await record('MEDIA-06B:solo-direct-resolve-does-not-require-room',async()=>{
      const response=await request(baseUrl,'/api/media/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/episode/master.m3u8?sig=test'})});
      assert.equal(response.status,200);assert.equal(response.json.provider,'direct-media');assert.equal(response.json.results[0].type,'hls');
    });
    await record('MEDIA-07:resolver-requires-current-host',async()=>{
      const created=await createRoom(baseUrl,'MEDIA1',{name:'MediaHost',roomCode:'811',accountId:'media-host-1'});assert.equal(created.status,201);const host=await joinRoom(baseUrl,'811',{name:'MediaHost',accountId:'media-host-1'});const guest=await joinRoom(baseUrl,'811',{name:'Guest',accountId:'media-guest-2'});assert.equal(host.status,200);assert.equal(guest.status,200);const response=await request(baseUrl,'/api/media/resolve',{method:'POST',headers:{'Content-Type':'application/json','x-member-id':guest.json.session.memberId},body:JSON.stringify({roomId:'811',url:'https://example.com/watch/episode-1'})});assert.equal(response.status,403);assert.equal(response.json.code,'HOST_REQUIRED');
    });
    await record('MEDIA-08:direct-hls-resolve-bypasses-page-browser',async()=>{
      const host=await joinRoom(baseUrl,'811',{name:'MediaHost',accountId:'media-host-1'});assert.equal(host.status,200);const response=await request(baseUrl,'/api/media/resolve',{method:'POST',headers:{'Content-Type':'application/json','x-member-id':host.json.session.memberId},body:JSON.stringify({roomId:'811',url:'https://example.com/episode/master.m3u8?sig=test'})});assert.equal(response.status,200);assert.equal(response.json.provider,'direct-media');assert.equal(response.json.results[0].url,'https://example.com/episode/master.m3u8?sig=test');assert.equal(response.json.results[0].type,'hls');
    });
    await record('MEDIA-09:room-source-rejects-private-media',async()=>{
      const joined=await joinRoom(baseUrl,'811',{name:'MediaHost',accountId:'media-host-1'});assert.equal(joined.status,200);const response=await request(baseUrl,'/api/rooms/MEDIA1/media-source',{method:'POST',headers:{'Content-Type':'application/json','x-member-id':joined.json.session.memberId},body:JSON.stringify({media:{url:'http://127.0.0.1/private.m3u8',type:'hls'}})});assert.equal(response.status,400);
    });
    await record('MEDIA-10:room-source-share-includes-server-time-and-revision',async()=>{
      const joined=await joinRoom(baseUrl,'811',{name:'MediaHost',accountId:'media-host-1'});assert.equal(joined.status,200);const memberId=joined.json.session.memberId;const before=Number(joined.json.state.revision);assert.ok(Number.isFinite(Number(joined.json.state.serverTime)));const response=await request(baseUrl,'/api/rooms/MEDIA1/media-source',{method:'POST',headers:{'Content-Type':'application/json','x-member-id':memberId},body:JSON.stringify({originalUrl:'https://example.com/watch/episode-1',media:{url:'https://example.com/video/master.m3u8',type:'hls',title:'Episode 1',server:'example',audio:'sub'}})});assert.equal(response.status,200);assert.equal(response.json.state.source.kind,'media');assert.equal(response.json.state.source.type,'hls');assert.equal(response.json.state.source.url,'https://example.com/video/master.m3u8');assert.equal(response.json.state.source.title,'Episode 1');assert.equal(response.json.state.source.audio,'sub');assert.ok(Number(response.json.state.revision)>before);assert.ok(Number(response.json.state.serverTime)>=before);
    });
    await record('MEDIA-11:local-hls-runtime-is-served',async()=>{
      const response=await request(baseUrl,'/vendor/hls.js',{method:'GET'});assert.equal(response.status,200);assert.match(String(response.headers['content-type']||''),/javascript/);assert.ok(String(response.body||'').includes('Hls'));
    });
  } finally { await server.stop(); }
  return results;
}
