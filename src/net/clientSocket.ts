import type {
  AmmoPackId,
  BeamVisualEvent,
  DailyMissionIneligibleReason,
  DailyMissionSummaryUpdate,
  GameModeId,
  MapId,
  MatchSnapshot,
  RobotClass,
  TeamId,
} from '../shared/types';
import {
  SNAPSHOT_PROTOCOL_VERSION,
  SnapshotRehydrator,
  type CompactMatchSnapshot,
} from '../shared/snapshotCodec';
import type { PartyView, SocialInvite, TacticalPing } from '../shared/social';
import { getSessionToken } from './account';

export interface ChatMessage {
  id: string;
  playerId: string;
  callsign: string;
  text: string;
  timestamp: number;
}

export interface MatchSummaryPayload {
  matchId: string;
  won: boolean;
  result?: 'win' | 'loss' | 'draw' | 'cancelled' | 'forfeit';
  cancelled?: boolean;
  isPrivate?: boolean;
  mode?: GameModeId;
  robotClass?: RobotClass;
  winningTeam?: string;
  winnerName?: string;
  placement?: number;
  kills: number;
  deaths: number;
  accuracy: number;
  damageDealt?: number;
  oreMined?: number;
  allyRepair?: number;
  coreControlSec?: number;
  barriersDestroyed?: number;
  pingsSent?: number;
  xpEarned: number;
  newXp?: number;
  scoreCobalt: number;
  scoreAmber: number;
  missionEligible?: boolean;
  missionIneligibleReason?: DailyMissionIneligibleReason;
  missionUpdates?: DailyMissionSummaryUpdate[];
}

export interface RoomSettings {
  name: string;
  mapId: MapId;
  mode: GameModeId;
  botFill: boolean;
  hazardIntensity: 'standard' | 'overdrive';
  friendlyFire: boolean;
}

export interface RoomView extends RoomSettings {
  roomId: string;
  hostId: string;
  isPrivate: boolean;
  minPlayers?: number;
  phase: 'waiting' | 'active' | 'ended';
  members: { id: string; callsign: string; connected: boolean; team: TeamId; ready: boolean }[];
  version: number;
  countdownEndsAt: number | null;
  canStart: boolean;
  matchId?: string | null;
}

export interface RoomPreview {
  roomId: string;
  name?: string;
  mapId?: MapId;
  mode?: GameModeId;
  playerCount?: number;
  available: boolean;
  error?: string;
}

export interface MatchOffer {
  offerId: string;
  expiresAt: number;
  accepted?: boolean;
  acceptedCount?: number;
}

export interface SessionView {
  room?: RoomView | null;
  queuedAt?: number | null;
  offer?: MatchOffer | null;
  summary?: MatchSummaryPayload | null;
  party?: PartyView | null;
  invites?: SocialInvite[];
  message?: string;
}

export interface EconomyNoticePayload {
  ok: boolean;
  reason?: string;
  packId?: AmmoPackId;
  ammo?: number;
  maxAmmo?: number;
  resetHeat?: boolean;
  teamCredits?: number;
}

export interface ClientSocketListeners {
  onSession?: (view: SessionView) => void;
  onError?: (error: { action?: string; code?: string }) => void;
  onSnapshot?: (snap: MatchSnapshot) => void;
  onRoomPreview?: (preview: RoomPreview) => void;
  onSocialInviteSent?: () => void;
  onTacticalPing?: (ping: TacticalPing) => void;
  onBeam?: (beam: BeamVisualEvent) => void;
  onHitConfirm?: (data: { targetId: string; damage: number; killed: boolean }) => void;
  onBarrierShatter?: (id: string) => void;
  onEconomyNotice?: (data: EconomyNoticePayload) => void;
  onMatchSummary?: (summary: MatchSummaryPayload) => void;
  onChat?: (msg: ChatMessage) => void;
  onPingUpdate?: (pingMs: number) => void;
  onConnectionChange?: (connected: boolean, closeCode?: number) => void;
}

type ServerPayload = Record<string, unknown>;

export class GameNetworkClient {
  private ws: WebSocket | null = null;
  private listeners: ClientSocketListeners = {};
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private lastPongAt = 0;
  private disposed = false;
  private pendingOpen = 0;
  private clockOffsetMs: number | undefined;
  private retryCount = 0;
  private snapshotRehydrator = new SnapshotRehydrator();
  private handshakeQueue: Array<{ type: string; payload: object }> = [];
  private lastSnapshotDecodeMeta: { decodeMs: number; bytes: number; timestampMs: number } | null = null;

  getLastSnapshotDecodeMeta(): { decodeMs: number; bytes: number; timestampMs: number } | null {
    return this.lastSnapshotDecodeMeta;
  }

  setListeners(listeners: ClientSocketListeners): void {
    this.listeners = listeners;
  }

  connect(): void {
    if (this.disposed || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    window.clearTimeout(this.reconnectTimer);
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('proto', String(SNAPSHOT_PROTOCOL_VERSION));
    const token = getSessionToken();
    const ws = token
      ? new WebSocket(url.toString(), ['prism.v2', `prism.auth.${token}`])
      : new WebSocket(url.toString());
    this.clockOffsetMs = undefined;
    this.snapshotRehydrator.reset();
    this.ws = ws;
    this.pendingOpen = window.setTimeout(() => ws.close(), 8000);

    ws.onopen = () => {
      if (ws !== this.ws) return;
      window.clearTimeout(this.pendingOpen);
      this.lastPongAt = Date.now();
      this.listeners.onConnectionChange?.(true);
      const ping = () => {
        if (Date.now() - this.lastPongAt >= 9000 || ws.bufferedAmount > 1_048_576) {
          ws.close();
          return;
        }
        this.send('ping', { clientTime: Date.now() });
      };
      this.pingTimer = window.setInterval(ping, 2500);
      ping();
      if (this.handshakeQueue.length > 0) {
        const queued = this.handshakeQueue.splice(0);
        for (const item of queued) {
          this.send(item.type, item.payload);
        }
      }
    };

    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      const parseStart = performance.now();
      const rawBytes = typeof ev.data === 'string' ? ev.data.length : 0;
      let msg: { type: string; payload?: ServerPayload };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      const payload = (msg.payload || {}) as ServerPayload;
      switch (msg.type) {
        case 'pong': {
          const now = this.lastPongAt = Date.now();
          const rtt = now - Number(payload.clientTime || now);
          if (typeof payload.serverTime === 'number' && rtt >= 0) this.clockOffsetMs = payload.serverTime + rtt / 2 - now;
          this.listeners.onPingUpdate?.(Math.max(1, rtt));
          break;
        }
        case 'session:state': {
          this.retryCount = 0;
          const state = payload as unknown as SessionView;
          const offset = this.clockOffsetMs ?? (typeof payload.serverTime === 'number' ? payload.serverTime - Date.now() : 0);
          if (state.offer) state.offer = { ...state.offer, expiresAt: state.offer.expiresAt - offset };
          if (state.room?.countdownEndsAt != null) state.room = { ...state.room, countdownEndsAt: state.room.countdownEndsAt - offset };
          if (state.invites) state.invites = state.invites.map(invite => ({ ...invite, expiresAt: invite.expiresAt - offset }));
          this.listeners.onSession?.(state);
          break;
        }
        case 'session:error':
          this.listeners.onError?.(payload);
          break;
        case 'room:preview':
          this.listeners.onRoomPreview?.(payload as unknown as RoomPreview);
          break;
        case 'social:sent':
          this.listeners.onSocialInviteSent?.();
          break;
        case 'match:ping': {
          const ping = payload as unknown as TacticalPing;
          const offset = this.clockOffsetMs ?? (typeof payload.serverTime === 'number' ? payload.serverTime - Date.now() : 0);
          this.listeners.onTacticalPing?.({ ...ping, expiresAt: ping.expiresAt - offset });
          break;
        }
        case 'room:joined':
        case 'room:reset':
          if (payload.snapshot) {
            const snapObj = payload.snapshot as Record<string, unknown>;
            if ('compact' in snapObj && snapObj.compact !== 1) {
              this.listeners.onError?.({ action: msg.type, code: 'protocol_mismatch' });
              break;
            }
            const hydrated = this.snapshotRehydrator.hydrate(snapObj as unknown as MatchSnapshot | CompactMatchSnapshot);
            const doneAt = performance.now();
            this.lastSnapshotDecodeMeta = {
              decodeMs: Math.max(0, doneAt - parseStart),
              bytes: rawBytes,
              timestampMs: doneAt,
            };
            this.listeners.onSnapshot?.(hydrated);
          }
          break;
        case 'match:state': {
          if ('compact' in payload && payload.compact !== 1) {
            this.listeners.onError?.({ action: 'match:state', code: 'protocol_mismatch' });
            break;
          }
          const hydrated = this.snapshotRehydrator.hydrate(payload as unknown as MatchSnapshot | CompactMatchSnapshot);
          const doneAt = performance.now();
          this.lastSnapshotDecodeMeta = {
            decodeMs: Math.max(0, doneAt - parseStart),
            bytes: rawBytes,
            timestampMs: doneAt,
          };
          this.listeners.onSnapshot?.(hydrated);
          break;
        }
        case 'match:beam':
          this.listeners.onBeam?.(payload as unknown as BeamVisualEvent);
          break;
        case 'hit:confirm':
          this.listeners.onHitConfirm?.(payload as unknown as { targetId: string; damage: number; killed: boolean });
          break;
        case 'barrier:shatter':
          this.listeners.onBarrierShatter?.(String(payload.id || ''));
          break;
        case 'economy:notice':
          this.listeners.onEconomyNotice?.(payload as unknown as EconomyNoticePayload);
          break;
        case 'match:summary':
          this.listeners.onMatchSummary?.(payload as unknown as MatchSummaryPayload);
          break;
        case 'chat:msg': {
          const text = payload as unknown as ChatMessage & { sender?: string };
          this.listeners.onChat?.({ ...text, callsign: text.sender ?? text.callsign });
          break;
        }
      }
    };

    ws.onclose = ({ code }) => {
      if (ws !== this.ws) return;
      window.clearTimeout(this.pendingOpen);
      window.clearInterval(this.pingTimer);
      this.ws = null;
      this.handshakeQueue = [];
      this.listeners.onConnectionChange?.(false, code);
      if (!this.disposed && ![4001, 4009, 4401, 4403, 4409].includes(code)) {
        const delay = Math.min(700 * 2 ** Math.min(this.retryCount++, 3), 2800) + Math.random() * 350;
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
      }
    };
  }

  send(type: string, payload: object = {}): boolean {
    if (this.ws?.readyState === WebSocket.CONNECTING && type !== 'ping' && !type.startsWith('player:')) {
      if (this.handshakeQueue.length < 4) {
        this.handshakeQueue.push({ type, payload });
        return true;
      }
      return false;
    }
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 262_144) return false;
    this.ws.send(JSON.stringify({ type, payload }));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.handshakeQueue = [];
    this.snapshotRehydrator.reset();
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.pendingOpen);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
