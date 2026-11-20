import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Crosshair, Skull } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { translateDynamicLabel } from '../i18n/translations';
import {
  classifyKillFeedInvolvement,
  createInitialKillFeedState,
  getKillFeedEntryPhase,
  getNextKillFeedTransitionMs,
  ingestKillFeedEvents,
  pruneExpiredKillFeed,
  type KillFeedInvolvement,
  type KillFeedState,
} from '../shared/killFeed';
import type { KillFeedEvent } from '../shared/types';

interface KillFeedProps {
  events: readonly KillFeedEvent[];
  localPlayerId: string;
  localCallsign?: string;
}

function getRowSurfaceClass(involvement: KillFeedInvolvement): string {
  switch (involvement) {
    case 'local_elimination':
      return 'bg-[#1A150B]/94 border-amber-400/60 shadow-md';
    case 'local_death':
      return 'bg-[#1D0C11]/94 border-red-500/65 shadow-md';
    case 'hazard_death':
      return 'bg-[#150D11]/92 border-red-400/35 shadow-sm';
    default:
      return 'bg-[#0B1019]/90 border-white/12 shadow-sm';
  }
}

function getDecayBarClass(
  involvement: KillFeedInvolvement,
  attackerTeam: KillFeedEvent['attackerTeam'],
): string {
  if (involvement === 'local_elimination') return 'bg-amber-400/80';
  if (involvement === 'local_death' || involvement === 'hazard_death') return 'bg-red-400/80';
  if (attackerTeam === 'cobalt') return 'bg-cyan-400/50';
  if (attackerTeam === 'amber') return 'bg-amber-400/50';
  return 'bg-red-400/55';
}

export const KillFeed: React.FC<KillFeedProps> = ({
  events,
  localPlayerId,
  localCallsign,
}) => {
  const { lang, t } = useI18n();
  const [state, setState] = useState<{ feed: KillFeedState; nowMs: number }>(() => ({
    feed: createInitialKillFeedState(),
    nowMs: Date.now(),
  }));

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevTopsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const now = Date.now();
    setState((prev) => {
      const nextFeed = ingestKillFeedEvents(prev.feed, events, now);
      if (nextFeed === prev.feed) return prev;
      return { feed: nextFeed, nowMs: now };
    });
  }, [events]);

  useEffect(() => {
    const nextTransitionMs = getNextKillFeedTransitionMs(state.feed.items, Date.now());
    if (nextTransitionMs === null) return;

    const timer = window.setTimeout(() => {
      const tickNow = Date.now();
      setState((prev) => ({
        feed: {
          ...prev.feed,
          items: pruneExpiredKillFeed(prev.feed.items, tickNow),
        },
        nowMs: tickNow,
      }));
    }, nextTransitionMs + 16);

    return () => window.clearTimeout(timer);
  }, [state]);

  // GPU-composited FLIP vertical scroll when new entries push older rows down
  useLayoutEffect(() => {
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const nextTops = new Map<string, number>();

    for (const item of state.feed.items) {
      const el = rowRefs.current.get(item.event.id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      nextTops.set(item.event.id, top);

      if (!reducedMotion) {
        const prevTop = prevTopsRef.current.get(item.event.id);
        if (prevTop !== undefined) {
          const deltaY = prevTop - top;
          if (Math.abs(deltaY) > 1) {
            el.style.transition = 'none';
            el.style.transform = `translate3d(0, ${deltaY}px, 0)`;
            void el.offsetHeight;
            el.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
            el.style.transform = 'translate3d(0, 0, 0)';
          }
        }
      }
    }

    prevTopsRef.current = nextTops;
  }, [state.feed.items]);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={t.killFeedAria}
      data-testid="kill-feed"
      className="pointer-events-none flex flex-col items-end gap-1.5 mt-1 w-full max-w-[380px]"
    >
      {state.feed.items.map((item) => {
        const { event } = item;
        const involvement = classifyKillFeedInvolvement(event, localPlayerId, localCallsign);
        const phase = getKillFeedEntryPhase(item, state.nowMs);
        const isEnvironmentalOnly = event.isHazard && event.attackerTeam === 'hazard';
        const attackerLabel = translateDynamicLabel(event.attackerName, lang);
        const methodLabel = translateDynamicLabel(event.weaponOrHazard, lang);

        const attackerColor =
          event.attackerTeam === 'cobalt'
            ? 'text-cyan-400'
            : event.attackerTeam === 'amber'
              ? 'text-amber-400'
              : 'text-red-400';
        const victimColor =
          event.victimTeam === 'cobalt' ? 'text-cyan-300' : 'text-amber-300';

        return (
          <div
            key={event.id}
            ref={(node) => {
              if (node) rowRefs.current.set(event.id, node);
              else rowRefs.current.delete(event.id);
            }}
            data-testid="kill-feed-item"
            data-event-id={event.id}
            data-involvement={involvement}
            data-phase={phase}
            className="will-change-transform max-w-full"
          >
            <div
              className={`chamfer-sm relative overflow-hidden border px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-mono-tabular whitespace-nowrap max-w-full ${getRowSurfaceClass(
                involvement,
              )} ${phase === 'exiting' ? 'killfeed-item-exit' : 'killfeed-item-enter'}`}
            >
              {involvement === 'local_death' ? (
                <Skull className="w-3.5 h-3.5 text-red-400 shrink-0" aria-hidden="true" />
              ) : isEnvironmentalOnly ? (
                <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" aria-hidden="true" />
              ) : (
                <Crosshair
                  className={`w-3.5 h-3.5 shrink-0 ${
                    involvement === 'local_elimination' ? 'text-amber-300' : 'text-slate-400'
                  }`}
                  aria-hidden="true"
                />
              )}

              {involvement === 'local_elimination' && (
                <span className="text-[10px] font-display font-bold tracking-wider uppercase text-amber-300 shrink-0">
                  {t.killFeedElimTag}
                </span>
              )}
              {involvement === 'local_death' && (
                <span className="text-[10px] font-display font-bold tracking-wider uppercase text-red-400 shrink-0">
                  {t.killFeedDownTag}
                </span>
              )}
              {involvement === 'hazard_death' && (
                <span className="text-[10px] font-display font-bold tracking-wider uppercase text-red-300/90 shrink-0">
                  {t.killFeedHazardTag}
                </span>
              )}

              <span
                className={`${attackerColor} ${
                  involvement === 'local_elimination' ? 'font-bold' : 'font-semibold'
                } truncate max-w-[112px]`}
              >
                {attackerLabel}
              </span>

              {isEnvironmentalOnly ? (
                <span className="text-red-400/70 shrink-0" aria-hidden="true">
                  ›
                </span>
              ) : (
                <span className="text-[10px] text-slate-400 tracking-tight shrink-0 flex items-center gap-1">
                  <span className="text-slate-600" aria-hidden="true">
                    /
                  </span>
                  <span className="max-w-[92px] truncate">{methodLabel}</span>
                  <span className="text-slate-600" aria-hidden="true">
                    ›
                  </span>
                </span>
              )}

              <span
                className={`${victimColor} ${
                  involvement === 'local_death' ? 'font-bold' : 'font-medium'
                } truncate max-w-[112px]`}
              >
                {event.victimName}
              </span>

              {/* Subtle compositor-only TTL decay hairline */}
              <span
                aria-hidden="true"
                className={`killfeed-ttl-bar absolute bottom-0 left-0 right-0 h-[1.5px] origin-left ${getDecayBarClass(
                  involvement,
                  event.attackerTeam,
                )}`}
                style={{ animationDuration: `${item.durationMs}ms` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
