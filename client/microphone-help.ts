export type MicrophoneBlock = 'insecure' | 'denied' | 'unavailable';
export function microphoneBlock(secure: boolean, supported: boolean, denied = false): MicrophoneBlock | undefined {
  if (!supported) return secure ? 'unavailable' : 'insecure';
  return denied ? 'denied' : undefined;
}
export function microphoneErrorBlock(error: unknown): MicrophoneBlock | undefined {
  if (!error || typeof error !== 'object' || !('name' in error)) return;
  if ('stage' in error && error.stage !== 'microphone') return;
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(String(error.name))) return 'denied';
  if (['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'NotSupportedError'].includes(String(error.name))) return 'unavailable';
}
export function microphoneInstructions(block: MicrophoneBlock, secure = true): string {
  const secureAccess = 'Open the pairing link from your computer at https://haze.build/remote/ using a browser with microphone and WebRTC support. Microphone capture requires the hosted HTTPS page and browser permission.';
  if (block === 'insecure' || !secure) return secureAccess;
  if (block === 'denied') return 'Remove any existing Block for Microphone in the browser’s site permissions, then reload and choose Allow for this request. On macOS, also enable your browser under System Settings → Privacy & Security → Microphone; restart the browser if you changed OS permissions. Then hold to talk again. If your browser or device is managed, ask its administrator.';
  return 'Connect or enable a microphone, close other apps using it, and check OS microphone permissions. Use a browser with microphone and WebRTC audio support, then try again.';
}
