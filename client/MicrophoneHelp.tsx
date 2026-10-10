import { microphoneInstructions, type MicrophoneBlock } from './microphone-help';

export function MicrophoneHelp({ block }: { block: MicrophoneBlock }) {
  return <section className="microphone-help" aria-labelledby="microphone-help-title">
    <h3 id="microphone-help-title">Microphone setup</h3>
    <p>{block === 'insecure' ? 'This browser blocks microphone access on the current HTTP origin.' : block === 'denied' ? 'Microphone access was denied or blocked by browser/device policy.' : 'Microphone capture is unavailable on this device or browser.'}</p>
    <p>{microphoneInstructions(block, window.isSecureContext)}</p>
  </section>;
}
