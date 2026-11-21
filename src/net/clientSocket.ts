import type { AmmoPackId, BeamVisualEvent, GameModeId, MapId, MatchSnapshot } from '../shared/types';

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
  winningTeam?: string;
  winnerName?: string;
  placement?: number;
  kills: number;
  deaths: number;
  accuracy: number;
  xpEarned: number;
  newXp?: number;
  scoreCobalt: number;
  scoreAmber: number;
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
  members: { id: string; callsign: string; connected: boolean }[];
  matchId?: string | null;
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
  private clockOffsetMs = 0;
  private retryCount = 0;

  setListeners(listeners: ClientSocketListeners): void {
    this.listeners = listeners;
  }

  connect(): void {
    if (this.disposed || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    window.clearTimeout(this.reconnectTimer);
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
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
    };

    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      let msg: { type: string; payload?: ServerPayload };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      const payload = (msg.payload || {}) as ServerPayload;
      switch (msg.type) {
        case 'pong': {
          this.lastPongAt = Date.now();
          const rtt = Date.now() - Number(payload.clientTime || Date.now());
          if (typeof payload.serverTime === 'number' && rtt >= 0) this.clockOffsetMs = payload.serverTime + rtt / 2 - Date.now();
          this.listeners.onPingUpdate?.(Math.max(1, rtt));
          break;
        }
        case 'session:state': {
          this.retryCount = 0;
          const state = payload as unknown as SessionView;
          if (state.offer) state.offer = { ...state.offer, expiresAt: state.offer.expiresAt - this.clockOffsetMs };
          this.listeners.onSession?.(state);
          break;
        }
        case 'session:error':
          this.listeners.onError?.(payload);
          break;
        case 'room:joined':
        case 'room:reset':
          if (payload.snapshot) this.listeners.onSnapshot?.(payload.snapshot as MatchSnapshot);
          break;
        case 'match:state':
          this.listeners.onSnapshot?.(payload as unknown as MatchSnapshot);
          break;
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
      this.listeners.onConnectionChange?.(false, code);
      if (!this.disposed && ![4001, 4009, 4401, 4403, 4409].includes(code)) {
        const delay = Math.min(700 * 2 ** Math.min(this.retryCount++, 3), 2800) + Math.random() * 350;
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
      }
    };
  }

  send(type: string, payload: object = {}): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 262_144) return false;
    this.ws.send(JSON.stringify({ type, payload }));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.pendingOpen);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
