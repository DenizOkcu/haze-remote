import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { probeHostOnlyIce } from './app-fixture.js';
// Numeric host candidates make the same-machine loopback test independent of multicast DNS.
test.use({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });
let vite: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, configFile: 'vite.config.ts' });
  await vite.listen();
  const address = vite.httpServer!.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); });

test('real browser host-only RTC framing, binding and pre-negotiated microphone', async ({ page, browserName }) => {
  await page.goto(`${origin}/remote/`);
  if (browserName === 'webkit') {
    const probe = await probeHostOnlyIce(page);
    await test.info().attach('host-only-ice-probe', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' });
    test.skip(probe.gathering === 'complete' && probe.usable === 0, 'WebKit host-only gathering completed with zero usable IPv4/mDNS candidates in this same-machine environment; physical devices remain untested.');
  }
  const result = await page.evaluate(async (workspace) => {
    const { BrowserLanSocket, descriptionFingerprint } = await (new Function('return import("/remote/browser-lan-socket.ts")'))();
    const { Framer, encodeFrames } = await (new Function(`return import("/remote/@fs${workspace}/shared/rtc-framing.ts")`))();
    const native = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const terminal = native.createDataChannel('terminal', { ordered: true });
    terminal.onopen = () => { for (const frame of encodeFrames(JSON.stringify({ type: 'transport-ready' }))) terminal.send(frame); };
    const audio = native.addTransceiver('audio', { direction: 'recvonly' });
    const pcmu = RTCRtpReceiver.getCapabilities('audio')!.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/pcmu');
    audio.setCodecPreferences(pcmu);
    await native.setLocalDescription(await native.createOffer());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host-only ICE gathering timed out')), 10000);
      const check = () => { if (native.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
      native.onicegatheringstatechange = check; check();
    });
    const inbox: any[] = [{ type: 'offer', sdp: native.localDescription!.sdp }];
    const posts: any[] = [];
    let left = 0;
    const fetchOriginal = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.haze.build/')) return fetchOriginal(input, init);
      let value: any = {};
      if (url.endsWith('/join')) value = { token: 'test-lease', expiresAt: Date.now() + 60_000 };
      else if (url.endsWith('/leave')) left++;
      else if (init?.method === 'GET') value = { messages: inbox.splice(0, 8) };
      else {
        const message = JSON.parse(init!.body as string); posts.push(message);
        if (message.type === 'answer') await native.setRemoteDescription(message);
        else if (message.type === 'candidate') await native.addIceCandidate(message);
      }
      if (url.endsWith('/messages')) value = { ...value, expiresAt: Date.now() + 60_000 };
      return new Response(JSON.stringify(value));
    };
    const socket = new BrowserLanSocket('a'.repeat(32));
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; setTimeout(() => reject(new Error(`RTC timed out native=${native.connectionState}/${native.iceConnectionState} socket=${socket.readyState}`)), 15_000); });
      const binding = socket.channelBinding;
      const bound = binding.clientFingerprint === descriptionFingerprint(native.remoteDescription!.sdp) && binding.serverFingerprint === descriptionFingerprint(native.localDescription!.sdp);
      const framer = new Framer();
      const wire = 'terminal 🦊 '.repeat(2000);
      const echoed = new Promise<string>(resolve => { socket.onmessage = (e: any) => resolve(e.data); });
      terminal.onmessage = e => { const assembled = framer.push(e.data); if (assembled !== undefined) for (const frame of encodeFrames(assembled)) terminal.send(frame); };
      socket.send(wire);
      const same = await echoed === wire;
      const context = new AudioContext(); const oscillator = context.createOscillator(); const output = context.createMediaStreamDestination();
      oscillator.connect(output); oscillator.start();
      const track = output.stream.getAudioTracks()[0];
      await socket.setMicrophone(track);
      await socket.setMicrophone(null);
      const stopped = track.readyState === 'ended';
      const answer = posts.find(p => p.type === 'answer').sdp;
      const sendonly = answer.includes('a=sendonly') && answer.includes('PCMU/8000');
      socket.close(); await context.close();
      await new Promise(resolve => setTimeout(resolve, 20));
      return { bound, same, stopped, sendonly, closed: socket.readyState === 3, left, hostOnly: posts.filter(p => p.type === 'candidate').every(p => p.candidate.includes(' typ host')) };
    } finally { socket.close(); native.close(); window.fetch = fetchOriginal; }
  }, process.cwd());
  expect(result).toEqual({ bound: true, same: true, stopped: true, sendonly: true, closed: true, left: 1, hostOnly: true });
});
