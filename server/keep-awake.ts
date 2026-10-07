import { spawn } from 'node:child_process';

export type KeepAwake = { enabled: boolean; stop: () => void };

function available(command: string): Promise<boolean> {
  return new Promise(resolve => {
    // 'command -v' is POSIX; /bin/sh exists on both supported platforms.
    const probe = spawn('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', code => resolve(code === 0));
  });
}

/**
 * Prevents host standby while haze-remote runs, so remote sessions do not die
 * when the computer would otherwise sleep. The assertion is tied to this
 * process's PID: the helper exits automatically when haze-remote stops, so the
 * machine can sleep normally again. Best-effort: unsupported systems simply
 * run without it.
 */
export async function acquireKeepAwake(options: { pid: number; disable?: boolean; log?: (message: string) => void }): Promise<KeepAwake> {
  const disabled: KeepAwake = { enabled: false, stop: () => {} };
  if (options.disable) return disabled;
  const log = options.log ?? (() => {});
  const darwin = process.platform === 'darwin';
  const command = darwin ? 'caffeinate' : 'systemd-inhibit';
  if (!await available(command)) {
    if (darwin) log(`Host standby prevention unavailable: ${command} not found. The computer may sleep during remote sessions.`);
    else log('Host standby prevention unavailable (no systemd). The computer may sleep during remote sessions.');
    return disabled;
  }
  // caffeinate -w <pid>: assertion held until our PID disappears (covers SIGKILL too).
  // systemd-inhibit -w <pid>: same contract where systemd exists.
  const child = darwin
    ? spawn(command, ['-dis', '-w', String(options.pid)], { stdio: 'ignore', detached: true })
    : spawn(command, ['--what=sleep:idle', '--mode=block', '--who=haze-remote', `--why=Remote Haze session active (${options.pid})`, '-w', String(options.pid)], { stdio: 'ignore', detached: true });
  child.on('error', () => log(`Could not start ${command}; the computer may sleep during remote sessions.`));
  // Never keep the event loop alive for the helper, and never crash with it.
  child.unref();
  return {
    enabled: true,
    stop: () => { try { child.kill(); } catch { /* Already gone. */ } },
  };
}
