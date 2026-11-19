import type {
  AmmoPackId,
  BeamVisualEvent,
  GameModeId,
  MatchSnapshot,
  Vec3,
  VoiceChannel,
  VoiceInputMode,
} from '../shared/types';

export interface ChatMessage {
  id: string;
  sender: string;
  team: string;
  text: string;
  timestamp: number;
}

export interface MatchSummaryPayload {
  won: boolean;
  mode?: GameModeId;
  winningTeam: string;
  winnerName?: string;
  placement?: number;
  kills: number;
  deaths: number;
  accuracy: number;
  mmrDelta: number;
  newMmr: number;
  xpEarned: number;
  newXp: number;
  scoreCobalt: number;
  scoreAmber: number;
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
  onSnapshot?: (snap: MatchSnapshot) => void;
  onBeam?: (beam: BeamVisualEvent) => void;
  onHitConfirm?: (data: { targetId: string; damage: number; killed: boolean }) => void;
  onBarrierShatter?: (id: string) => void;
  onAntiCheatCorrect?: (pos: Vec3) => void;
  onEconomyNotice?: (data: EconomyNoticePayload) => void;
  onMatched?: (data: { roomId: string; team?: string }) => void;
  onRoomJoined?: (data: { roomId: string; playerId: string; team: string; snapshot: MatchSnapshot }) => void;
  onRoomReset?: (data: { snapshot: MatchSnapshot }) => void;
  onMatchSummary?: (summary: MatchSummaryPayload) => void;
  onChat?: (msg: ChatMessage) => void;
  onPingUpdate?: (pingMs: number) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class GameNetworkClient {
  private ws: WebSocket | null = null;
  private playerId: string;
  private callsign: string;
  private listeners: ClientSocketListeners = {};
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private disposed = false;

  // WebRTC Voice state
  private localStream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private remoteAudios = new Map<string, HTMLAudioElement>();
  private latestSnapshot: MatchSnapshot | null = null;
  public voiceChannel: VoiceChannel = 'team';
  public voiceInputMode: VoiceInputMode = 'ptt';
  public micReady = false;
  public micError: string | null = null;
  public isSpeaking = false;

  constructor(playerId: string, callsign: string) {
    this.playerId = playerId;
    this.callsign = callsign;
  }

  setIdentity(playerId: string, callsign: string): void {
    this.playerId = playerId;
    this.callsign = callsign;
    this.send('auth:hello', { playerId, callsign });
  }

  setListeners(listeners: ClientSocketListeners): void {
    this.listeners = listeners;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.listeners.onConnectionChange?.(true);
      this.send('auth:hello', { playerId: this.playerId, callsign: this.callsign });
      this.send('room:join', { roomId: 'PUBLIC-ALPHA' });
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        this.send('ping', { clientTime: Date.now() });
      }, 3000);
      this.send('ping', { clientTime: Date.now() });
    };

    ws.onmessage = (ev) => {
      let msg: { type: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const payload = (msg.payload || {}) as Record<string, unknown>;
      switch (msg.type) {
        case 'pong': {
          const sent = Number(payload.clientTime || Date.now());
          const rtt = Math.max(2, Date.now() - sent);
          this.listeners.onPingUpdate?.(rtt);
          break;
        }
        case 'room:joined': {
          this.closeAllPeers();
          const joined = payload as unknown as { roomId: string; playerId: string; team: string; snapshot: MatchSnapshot };
          this.latestSnapshot = joined.snapshot;
          this.syncPeersWithSnapshot(joined.snapshot);
          this.listeners.onRoomJoined?.(joined);
          break;
        }
        case 'room:reset': {
          const resetData = payload as unknown as { snapshot: MatchSnapshot };
          this.latestSnapshot = resetData.snapshot;
          this.listeners.onRoomReset?.(resetData);
          break;
        }
        case 'match:state': {
          const snap = payload as unknown as MatchSnapshot;
          this.latestSnapshot = snap;
          this.syncPeersWithSnapshot(snap);
          this.listeners.onSnapshot?.(snap);
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
        case 'anticheat:correct':
          this.listeners.onAntiCheatCorrect?.(payload as unknown as Vec3);
          break;
        case 'economy:notice':
          this.listeners.onEconomyNotice?.(payload as unknown as EconomyNoticePayload);
          break;
        case 'mmq:matched':
          this.listeners.onMatched?.(payload as unknown as { roomId: string; team?: string });
          break;
        case 'match:summary':
          this.listeners.onMatchSummary?.(payload as unknown as MatchSummaryPayload);
          break;
        case 'chat:msg':
          this.listeners.onChat?.(payload as unknown as ChatMessage);
          break;
        case 'rtc:offer':
          void this.handleRtcOffer(payload);
          break;
        case 'rtc:answer':
          void this.handleRtcAnswer(payload);
          break;
        case 'rtc:ice':
          void this.handleRtcIce(payload);
          break;
      }
    };

    ws.onclose = () => {
      if (this.pingTimer) {
        window.clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.listeners.onConnectionChange?.(false);
      if (!this.disposed) {
        if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
      }
    };
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  joinRoom(roomId: string): void {
    this.send('room:join', { roomId });
  }

  requestRematch(): void {
    this.send('room:rematch', {});
  }

  joinMatchmaking(mode: string, mapId: string): void {
    this.send('mmq:join', { mode, mapId });
  }

  leaveMatchmaking(): void {
    this.send('mmq:leave', {});
  }

  buyAmmo(packId: AmmoPackId): void {
    this.send('player:buy_ammo', { packId });
  }

  sendMine(): void {
    this.send('player:mine', {});
  }

  triggerClassSkill(): void {
    this.send('player:class_skill', {});
  }

  async initMicrophone(): Promise<boolean> {
    if (this.localStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micError = 'Microphone API unavailable in this browser';
      return false;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.micReady = true;
      this.micError = null;
      this.updateTrackMute();

      // Attach local audio tracks to any existing WebRTC peers and renegotiate
      for (const [remoteId, pc] of this.peers.entries()) {
        const hasAudioSender = pc.getSenders().some((s) => s.track?.kind === 'audio');
        if (!hasAudioSender) {
          this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.send('rtc:offer', { targetId: remoteId, sdp: offer });
          } catch {
            // Ignore transient renegotiation failure
          }
        }
      }
      return true;
    } catch {
      this.micError = 'Microphone access denied or no hardware device detected';
      this.micReady = false;
      return false;
    }
  }

  setVoiceChannel(channel: VoiceChannel): void {
    this.voiceChannel = channel;
    this.updateTrackMute();
    if (channel === 'muted') {
      this.setSpeaking(false);
    }
    if (this.latestSnapshot) {
      this.applyVoiceChannelRouting(this.latestSnapshot);
    }
  }

  setSpeaking(active: boolean): void {
    const canSpeak = active && this.voiceChannel !== 'muted';
    if (this.isSpeaking === canSpeak) return;
    this.isSpeaking = canSpeak;
    this.updateTrackMute();
    this.send('voice:speaking', { speaking: canSpeak });
  }

  private updateTrackMute(): void {
    if (!this.localStream) return;
    const enabled = this.voiceChannel !== 'muted' && (this.voiceInputMode === 'open' || this.isSpeaking);
    this.localStream.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  private closePeer(remoteId: string): void {
    const pc = this.peers.get(remoteId);
    if (pc) {
      pc.close();
      this.peers.delete(remoteId);
    }
    const audio = this.remoteAudios.get(remoteId);
    if (audio) {
      audio.srcObject = null;
      this.remoteAudios.delete(remoteId);
    }
  }

  private closeAllPeers(): void {
    for (const remoteId of Array.from(this.peers.keys())) {
      this.closePeer(remoteId);
    }
  }

  private syncPeersWithSnapshot(snap: MatchSnapshot): void {
    if (typeof RTCPeerConnection === 'undefined') return;
    const remoteHumans = new Set<string>();
    for (const p of snap.players) {
      if (!p.isBot && p.id !== this.playerId) {
        remoteHumans.add(p.id);
        // Deterministic initiator: lexicographically smaller playerId sends initial offer
        if (!this.peers.has(p.id) && this.playerId < p.id) {
          void this.initiatePeerOffer(p.id);
        }
      }
    }
    for (const existingId of Array.from(this.peers.keys())) {
      if (!remoteHumans.has(existingId)) {
        this.closePeer(existingId);
      }
    }
    this.applyVoiceChannelRouting(snap);
  }

  private applyVoiceChannelRouting(snap: MatchSnapshot): void {
    const me = snap.players.find((p) => p.id === this.playerId);
    for (const [remoteId, audio] of this.remoteAudios.entries()) {
      const peer = snap.players.find((p) => p.id === remoteId);
      if (!peer || this.voiceChannel === 'muted') {
        audio.muted = true;
        audio.volume = 0;
        continue;
      }
      if (this.voiceChannel === 'proximity' && me) {
        const dist = Math.hypot(me.x - peer.x, me.z - peer.z);
        const vol = Math.max(0, Math.min(1, 1 - dist / 28));
        audio.volume = vol;
        audio.muted = vol <= 0.02;
      } else {
        // Team / Squad channel
        const allowed = snap.mode !== 'ffa' && me ? peer.team === me.team : false;
        audio.muted = !allowed;
        audio.volume = allowed ? 1 : 0;
      }
    }
  }

  private async initiatePeerOffer(remoteId: string): Promise<void> {
    const pc = await this.getOrCreatePeer(remoteId);
    if (!this.localStream && pc.getTransceivers().length === 0) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send('rtc:offer', { targetId: remoteId, sdp: offer });
    } catch {
      // Ignore transient signaling error
    }
  }

  private async getOrCreatePeer(remoteId: string): Promise<RTCPeerConnection> {
    if (this.peers.has(remoteId)) return this.peers.get(remoteId)!;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.send('rtc:ice', { targetId: remoteId, candidate: ev.candidate });
      }
    };
    pc.ontrack = (ev) => {
      let audio = this.remoteAudios.get(remoteId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        this.remoteAudios.set(remoteId, audio);
      }
      audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      if (this.latestSnapshot) {
        this.applyVoiceChannelRouting(this.latestSnapshot);
      }
    };
    this.peers.set(remoteId, pc);
    return pc;
  }

  private async handleRtcOffer(payload: Record<string, unknown>): Promise<void> {
    const fromId = String(payload.fromId || '');
    if (!fromId || !payload.sdp) return;
    try {
      const pc = await this.getOrCreatePeer(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send('rtc:answer', { targetId: fromId, sdp: answer });
    } catch {
      // Ignore signaling race
    }
  }

  private async handleRtcAnswer(payload: Record<string, unknown>): Promise<void> {
    const fromId = String(payload.fromId || '');
    const pc = this.peers.get(fromId);
    if (!pc || !payload.sdp) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit));
      }
    } catch {
      // Ignore signaling race
    }
  }

  private async handleRtcIce(payload: Record<string, unknown>): Promise<void> {
    const fromId = String(payload.fromId || '');
    const pc = this.peers.get(fromId);
    if (!pc || !payload.candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate as RTCIceCandidateInit));
    } catch {
      // Ignore late ICE candidates
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.closeAllPeers();
    this.localStream?.getTracks().forEach((t) => t.stop());
  }
}
