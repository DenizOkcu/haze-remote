import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { peerHarness, type TestSocket } from '../helpers.js';

/** Probe the exact host-only, PCMU, same-browser layout without involving auth.
 * Gathering completion alone is not evidence that WebKit emitted usable candidates. */
export async function probeHostOnlyIce(page: Page) {
  return page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const candidates: string[] = [];
    const states: string[] = [];
    pc.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate.candidate); };
    pc.onicegatheringstatechange = () => states.push(pc.iceGatheringState);
    pc.createDataChannel('probe', { ordered: true });
    const audio = pc.addTransceiver('audio', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities('audio')?.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/pcmu') ?? [];
    try {
      if (!codecs.length) throw new Error('PCMU capability missing');
      audio.setCodecPreferences(codecs);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 10000);
        const check = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
        pc.addEventListener('icegatheringstatechange', check); check();
      });
      const { hostCandidate } = await (new Function("return import('/remote/browser-lan-socket.ts')"))();
      const stats: any[] = [];
      (await pc.getStats()).forEach(s => { if (['local-candidate', 'candidate-pair', 'transport'].includes(s.type)) stats.push(s); });
      return { candidates, usable: candidates.filter(hostCandidate).length, gathering: pc.iceGatheringState, ice: pc.iceConnectionState, connection: pc.connectionState, states, codecs: codecs.map(c => c.mimeType), stats };
    } finally { pc.close(); }
  });
}

/** Real App, RTC data channel and OPAQUE; only signaling and the native server
 * peer are replaced. The server binding is taken from the actual RTC descriptions. */
export async function appFixture(page: Page, transport: ReturnType<typeof peerHarness>) {
  const vite: ViteDevServer = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/remote/`;
  const sockets = new Map<number, TestSocket>();
  const browserErrors: string[] = [];
  page.on('pageerror', error => { browserErrors.push(error.message); console.log('RTC browser error:', error.message); });
  page.on('console', message => { if (message.type() === 'error') { browserErrors.push(message.text()); console.log('RTC browser console:', message.text()); } });
  await page.exposeFunction('__peerReset', () => { for (const socket of sockets.values()) socket.close(); });
  await page.exposeFunction('__peerOpen', (id: number, binding: TestSocket['channelBinding']) => {
    const socket = transport.socket(binding); sockets.set(id, socket);
    socket.onmessage = ({ data }) => { void page.evaluate(({ id, data }) => (window as any).__peers.get(id)?.send(data), { id, data }).catch(() => {}); };
    socket.onclose = () => { void page.evaluate(id => (window as any).__peers.get(id)?.close(), id).catch(() => {}); };
  });
  await page.exposeFunction('__peerMessage', (id: number, data: string) => sockets.get(id)?.send(data));
  await page.exposeFunction('__peerClose', (id: number) => sockets.get(id)?.close());
  await page.addInitScript(({ workspace }) => {
    const peers = new Map(); (window as any).__peers = peers;
    const diagnostics: any[] = []; (window as any).__rtcDiagnostics = diagnostics;
    const OriginalPeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(config?: RTCConfiguration) {
        super(config);
        const id = diagnostics.length;
        const evidence: any = { id, candidates: [], states: [], stats: [] }; diagnostics.push(evidence);
        const record = async () => {
          evidence.states.push({ signaling: this.signalingState, gathering: this.iceGatheringState, ice: this.iceConnectionState, connection: this.connectionState });
          try { const stats: any[] = []; (await this.getStats()).forEach(s => { if (['transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type)) stats.push(s); }); evidence.stats = stats; } catch { /* closed peer */ }
        };
        for (const event of ['signalingstatechange', 'icegatheringstatechange', 'iceconnectionstatechange', 'connectionstatechange']) this.addEventListener(event, () => void record());
        this.addEventListener('icecandidate', event => { if (event.candidate) evidence.candidates.push(event.candidate.candidate); });
      }
    };
    let serial = Math.floor(Math.random() * 1e12), current: any;
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.haze.build/')) return original(input, init);
      let value: any = {};
      if (url.endsWith('/join')) {
        diagnostics.push({ stage: 'join' });
        await (window as any).__peerReset();
        diagnostics.push({ stage: 'reset' });
        // Init-script functions have no document module base in WebKit. Root-relative
        // dynamic imports fail with "unsupported URL"; use explicit HTTP module URLs.
        const { Framer, encodeFrames } = await (new Function(`return import(${JSON.stringify(location.origin + '/remote/@fs' + workspace + '/shared/rtc-framing.ts')})`))();
        const { descriptionFingerprint } = await (new Function(`return import(${JSON.stringify(location.origin + '/remote/browser-lan-socket.ts')})`))();
        diagnostics.push({ stage: 'imports' });
        const id = ++serial;
        const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
        const channel = pc.createDataChannel('terminal', { ordered: true });
        const audio = pc.addTransceiver('audio', { direction: 'recvonly' });
        audio.setCodecPreferences(RTCRtpReceiver.getCapabilities('audio')!.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/pcmu'));
        const framer = new Framer();
        let opened: Promise<void>;
        channel.onopen = () => {
          opened = (window as any).__peerOpen(id, { clientFingerprint: descriptionFingerprint(pc.remoteDescription!.sdp), serverFingerprint: descriptionFingerprint(pc.localDescription!.sdp) });
          void opened.then(() => { for (const frame of encodeFrames(JSON.stringify({ type: 'transport-ready' }))) channel.send(frame); });
        };
        channel.onmessage = async event => { await opened; const data = framer.push(event.data); if (data !== undefined) await (window as any).__peerMessage(id, data); };
        pc.onconnectionstatechange = () => { if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) void (window as any).__peerClose(id); };
        peers.set(id, { send(data: string) { if (channel.readyState === 'open') for (const frame of encodeFrames(data)) channel.send(frame); }, close() { pc.close(); void (window as any).__peerClose(id); } });
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Loopback host-only ICE gathering timed out')), 10000);
          const check = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }; pc.onicegatheringstatechange = check; check();
        });
        current = { id, pc, inbox: [{ type: 'offer', sdp: pc.localDescription!.sdp }] };
        value = { token: String(id), expiresAt: Date.now() + 60000 };
      } else if (url.endsWith('/leave')) { /* The RTC close callback releases the server socket. */ }
      else if (init?.method === 'GET') value = { messages: current?.inbox.splice(0, 8) ?? [], expiresAt: Date.now() + 60000 };
      else if (current) {
        const message = JSON.parse(init!.body as string);
        diagnostics.push({ signal: message.type, candidate: message.type === 'candidate' ? message.candidate : undefined, pcmu: message.type === 'answer' ? message.sdp.includes('PCMU/8000') : undefined });
        if (message.type === 'answer') await current.pc.setRemoteDescription(message);
        else if (message.type === 'candidate') await current.pc.addIceCandidate(message);
      }
      if (url.endsWith('/messages')) value = { ...value, expiresAt: Date.now() + 60000 };
      return new Response(JSON.stringify(value));
    };
  }, { workspace: process.cwd() });
  return {
    origin,
    async pair(remote: { pairingUrl(): string | undefined }) {
      const link = new URL(remote.pairingUrl()!);
      await page.goto(origin + link.hash);
      if (test.info().project.name.startsWith('webkit')) {
        const probe = await probeHostOnlyIce(page);
        const evidence = { probe, peers: await page.evaluate(() => (window as any).__rtcDiagnostics) };
        console.log('WebKit host-only RTC evidence:', JSON.stringify(evidence));
        await test.info().attach('host-only-rtc-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
        test.skip(probe.gathering === 'complete' && probe.usable === 0, 'WebKit same-machine host-only probe completed with zero usable IPv4/mDNS candidates (no STUN/TURN). Physical LAN devices remain untested.');
      }
      try { await expect(page.locator('.app-header [role="status"]')).toHaveText('Connected', { timeout: 15000 }); }
      catch (error) {
        const evidence = { browserErrors, peers: await page.evaluate(() => (window as any).__rtcDiagnostics), text: await page.locator('body').innerText() };
        console.log('RTC failure evidence:', JSON.stringify(evidence));
        await test.info().attach('rtc-failure-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
        throw error;
      }
      if (test.info().project.name.startsWith('webkit')) {
        const evidence = { browserErrors, peers: await page.evaluate(() => (window as any).__rtcDiagnostics) };
        console.log('RTC connected evidence:', JSON.stringify(evidence));
        await test.info().attach('rtc-connected-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      }
      expect(new URL(page.url()).hash).not.toContain('secret');
      expect(new URL(page.url()).hostname).toBe('127.0.0.1');
    },
    async disconnect() { for (const socket of sockets.values()) socket.close(); },
    async close() { for (const socket of sockets.values()) socket.close(); await vite.close(); },
  };
}
