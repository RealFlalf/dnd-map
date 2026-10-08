import { PROTOCOL_VERSION } from '@dnd-map/shared';
import { useEffect, useState } from 'react';
import { socket } from './socket';

type Health = 'loading' | 'ok' | 'error';
type Link =
  | { state: 'connecting' }
  | { state: 'online'; latencyMs: number | null; protocolMismatch: boolean }
  | { state: 'offline' };

export function App() {
  const [health, setHealth] = useState<Health>('loading');
  const [link, setLink] = useState<Link>({ state: 'connecting' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setHealth(res.ok ? 'ok' : 'error'))
      .catch(() => setHealth('error'));
  }, []);

  useEffect(() => {
    const measure = async () => {
      const sentAt = performance.now();
      try {
        await socket.timeout(3000).emitWithAck('system.ping');
        const latencyMs = Math.round(performance.now() - sentAt);
        setLink((prev) => (prev.state === 'online' ? { ...prev, latencyMs } : prev));
      } catch {
        // Timed out; the disconnect handler reports the outage.
      }
    };

    socket.on('system.hello', ({ protocolVersion }) => {
      setLink({
        state: 'online',
        latencyMs: null,
        protocolMismatch: protocolVersion !== PROTOCOL_VERSION,
      });
      void measure();
    });
    socket.on('disconnect', () => setLink({ state: 'offline' }));
    socket.connect();
    const timer = setInterval(() => void measure(), 5000);

    return () => {
      clearInterval(timer);
      socket.off('system.hello');
      socket.off('disconnect');
      socket.disconnect();
    };
  }, []);

  return (
    <main className="status">
      <h1>DnD Map</h1>
      <p>Каркас проекта. Здесь будет интерактивная карта.</p>
      <ul>
        <li>
          API и база данных:{' '}
          {health === 'loading' ? 'проверка…' : health === 'ok' ? '✅ работают' : '❌ недоступны'}
        </li>
        <li>
          Realtime-соединение: {link.state === 'connecting' && 'подключение…'}
          {link.state === 'offline' && '❌ нет связи'}
          {link.state === 'online' &&
            (link.protocolMismatch
              ? '⚠️ версия протокола не совпадает — обновите страницу'
              : `✅ на связи${link.latencyMs === null ? '' : ` (${link.latencyMs} мс)`}`)}
        </li>
      </ul>
    </main>
  );
}
