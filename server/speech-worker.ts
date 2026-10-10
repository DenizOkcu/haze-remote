import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SPEECH_SAMPLE_RATE } from '../shared/speech.js';

type Stream = { acceptWaveform(value: { sampleRate: number; samples: Float32Array }): void };
type Recognizer = { createStream(): Stream; decode(stream: Stream): void; getResult(stream: Stream): { text: string } };
// A separate process isolates native inference and can be killed on cancellation.
process.once('message', (message: { directory: string; audio: Buffer }) => {
  const pcm = message.audio;
  const samples = new Float32Array(pcm.length / 2);
  try {
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    pcm.fill(0);
    const { OfflineRecognizer } = createRequire(import.meta.url)('sherpa-onnx-node') as { OfflineRecognizer: new (config: unknown) => Recognizer };
    const file = (name: string) => join(message.directory, name);
    const recognizer = new OfflineRecognizer({
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') },
        tokens: file('tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0, modelType: 'nemo_transducer' },
    });
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SPEECH_SAMPLE_RATE, samples });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    samples.fill(0);
    process.send?.({ text }, () => process.exit(0));
  } catch {
    pcm.fill(0); samples.fill(0);
    process.send?.({ error: 'Local transcription failed. Check that this host supports the speech runtime and retry.' }, () => process.exit(1));
  }
});
process.on('disconnect', () => process.exit(0));
