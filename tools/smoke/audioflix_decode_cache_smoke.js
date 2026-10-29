const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'js/modules/features/audioflix/audioflix.audio.codec.js'),
    'utf8'
);

let fetchCount = 0;
let pendingDuration = 0;
const fakeContext = {
    async decodeAudioData() {
        const duration = pendingDuration;
        return {
            duration,
            length: Math.floor(duration * 1000),
            sampleRate: 1000,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(Math.floor(duration * 1000))
        };
    }
};
const windowObject = { EveAudioflixAudioCodec: {} };
const context = vm.createContext({
    window: windowObject,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    fetch: async (url) => {
        fetchCount += 1;
        pendingDuration = String(url).includes('long') ? 180 : 10;
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) };
    },
    Float32Array,
    Int16Array,
    Uint8Array,
    String,
    Number,
    Math,
    Map,
    WeakMap
});
vm.runInContext(source, context, { filename: 'audioflix.audio.codec.js' });

(async () => {
    const codec = windowObject.EveAudioflixAudioCodec;
    const concurrent = await Promise.all([
        codec.getDecodedBuffer('short.wav', () => fakeContext),
        codec.getDecodedBuffer('short.wav', () => fakeContext),
        codec.getDecodedBuffer('short.wav', () => fakeContext)
    ]);
    if (!concurrent.every((buffer) => buffer === concurrent[0]) || fetchCount !== 1) {
        throw new Error('concurrent clicks did not share one in-flight decode');
    }
    const shortA = concurrent[0];
    const shortB = await codec.getDecodedBuffer('short.wav', () => fakeContext);
    if (shortA !== shortB || fetchCount !== 1) throw new Error('short clip was not reused from the decode cache');
    let channelReads = 0;
    const encodeBuffer = { length: 4, sampleRate: 4, getChannelData() { channelReads += 1; return new Float32Array([0, .5, -.5, 1]); } };
    const encodedA = codec.encodeBufferToBase64(encodeBuffer), encodedB = codec.encodeBufferToBase64(encodeBuffer);
    if (encodedA !== encodedB || channelReads !== 1) throw new Error('layered clip PCM was re-encoded on the main thread');

    await codec.getDecodedBuffer('long.mp3', () => fakeContext);
    await codec.getDecodedBuffer('long.mp3', () => fakeContext);
    if (fetchCount !== 3) throw new Error('long music buffer was retained in the decode cache');

    const stats = codec.getCacheStats();
    if (stats.entries !== 1 || stats.samples !== 10000) throw new Error(`unexpected cache bounds: ${JSON.stringify(stats)}`);
    codec.clearCache(); codec.encodeBufferToBase64(encodeBuffer);
    if (channelReads !== 2) throw new Error('clearing the audio cache retained an encoded PCM payload');
    console.log('AUDIOFLIX_DECODE_CACHE_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
