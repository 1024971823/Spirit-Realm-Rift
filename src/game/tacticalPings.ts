import type { TacticalPingKind } from '../shared/social';

export const TACTICAL_PINGS = {
  rally: { zh: '集合', en: 'Rally', color: '#67E8F9', symbol: '⬥', arrow: '↑' },
  danger: { zh: '危险', en: 'Danger', color: '#FDA4AF', symbol: '!', arrow: '→' },
  mine: { zh: '采矿', en: 'Mine', color: '#FCD34D', symbol: '◆', arrow: '↓' },
  support: { zh: '请求支援', en: 'Need support', color: '#86EFAC', symbol: '+', arrow: '←' },
} satisfies Record<TacticalPingKind, { zh: string; en: string; color: string; symbol: string; arrow: string }>;

export const TACTICAL_KEYS: Partial<Record<string, TacticalPingKind>> = {
  ArrowUp: 'rally',
  ArrowRight: 'danger',
  ArrowDown: 'mine',
  ArrowLeft: 'support',
};

export function tacticalDirection(x: number, y: number): TacticalPingKind {
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'danger' : 'support') : (y < 0 ? 'rally' : 'mine');
}
