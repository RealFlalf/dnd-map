import type { JoinError, JoinRequest, ParticipantView } from '@dnd-map/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findSession } from '../api';
import { socket } from '../socket';
import { forgetParticipantKey, getParticipantKey, saveParticipantKey } from '../storage';

export type SessionState =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'need_name'; error?: JoinError }
  | { status: 'joining' }
  | {
      status: 'joined';
      inviteCode: string;
      self: ParticipantView;
      participants: ParticipantView[];
      connected: boolean;
    }
  | { status: 'failed'; error: JoinError | 'network' };

/**
 * Connects to a session and keeps the membership alive across reconnects:
 * every (re)connect re-sends `session.join` with the stored participant key.
 */
export function useSession(rawInviteCode: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  // What to send on the next connect; switches to the key once the server has issued one.
  const request = useRef<JoinRequest | null>(null);

  const sendJoin = useCallback(async () => {
    const req = request.current;
    if (!req) return;
    let result;
    try {
      result = await socket.timeout(5000).emitWithAck('session.join', req);
    } catch {
      return; // no ack: the disconnect/reconnect cycle will retry
    }

    if (result.ok) {
      if (result.participantKey) saveParticipantKey(result.inviteCode, result.participantKey);
      const key = result.participantKey ?? ('key' in req ? req.key : undefined);
      if (key) request.current = { inviteCode: result.inviteCode, key };
      setState({
        status: 'joined',
        inviteCode: result.inviteCode,
        self: result.self,
        participants: result.participants,
        connected: true,
      });
      return;
    }

    request.current = null;
    socket.disconnect();
    if (result.error === 'unknown_participant') {
      // The stored key is stale (e.g. the database was reset): join again as a new player.
      forgetParticipantKey(req.inviteCode);
      setState({ status: 'need_name' });
    } else if (result.error === 'session_not_found') {
      setState({ status: 'not_found' });
    } else if (result.error === 'invalid_request') {
      setState({ status: 'need_name', error: result.error });
    } else {
      setState({ status: 'failed', error: result.error });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const onConnect = () => void sendJoin();
    const onDisconnect = () =>
      setState((s) => (s.status === 'joined' ? { ...s, connected: false } : s));
    const onParticipants = (participants: ParticipantView[]) =>
      setState((s) => (s.status === 'joined' ? { ...s, participants } : s));

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session.participants', onParticipants);

    findSession(rawInviteCode)
      .then((inviteCode) => {
        if (cancelled) return;
        if (!inviteCode) return setState({ status: 'not_found' });
        const key = getParticipantKey(inviteCode);
        if (!key) return setState({ status: 'need_name' });
        request.current = { inviteCode, key };
        setState({ status: 'joining' });
        socket.connect();
      })
      .catch(() => !cancelled && setState({ status: 'failed', error: 'network' }));

    return () => {
      cancelled = true;
      request.current = null;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session.participants', onParticipants);
      socket.disconnect();
    };
  }, [rawInviteCode, sendJoin]);

  const joinAsPlayer = useCallback(
    (displayName: string) => {
      request.current = { inviteCode: rawInviteCode, displayName };
      setState({ status: 'joining' });
      if (socket.connected) void sendJoin();
      else socket.connect();
    },
    [rawInviteCode, sendJoin],
  );

  return { state, joinAsPlayer };
}
