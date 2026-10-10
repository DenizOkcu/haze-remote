export function consumePairingFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>) {
  const params = new URLSearchParams(location.hash.slice(1));
  const room = params.get('room') ?? '';
  const secret = params.get('secret') ?? '';
  const validRoom = /^[a-f0-9]{32}$/.test(room) ? room : '';
  // Always remove secrets, including malformed ones, before any asynchronous work.
  history.replaceState(null, '', `${location.pathname}${location.search}${validRoom ? `#room=${validRoom}` : ''}`);
  return { room: validRoom, secret: /^[a-f0-9]{64}$/.test(secret) ? secret : '' };
}
