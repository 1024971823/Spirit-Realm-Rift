import type { TeamId, Vec3 } from './types.ts';

export type FriendStatus = 'offline' | 'online' | 'in_room' | 'in_match';
export interface SocialView {
  friendCode: string;
  allowInvites: boolean;
  friends: { id: string; callsign: string; status: FriendStatus }[];
  incoming: { playerId: string; callsign: string }[];
  outgoing: { playerId: string; callsign: string }[];
}
export interface SocialInvite {
  id: string;
  kind: 'room' | 'party';
  senderId: string;
  senderName: string;
  expiresAt: number;
}
export interface PartyView {
  id: string;
  leaderId: string;
  members: { id: string; callsign: string; connected: boolean }[];
}
export type TacticalPingKind = 'rally' | 'danger' | 'mine' | 'support';
export interface TacticalPing {
  id: string;
  matchId: string;
  playerId: string;
  callsign: string;
  team: TeamId;
  kind: TacticalPingKind;
  position: Vec3;
  expiresAt: number;
}
