import React, { useMemo } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { buildMinimapFrame, type LocalPlayerPoseOverride } from '../shared/minimap';
import type { MapDefinition, MatchSnapshot, TeamId } from '../shared/types';

interface TacticalMinimapProps {
  map: MapDefinition;
  localizedMapName: string;
  snapshot: MatchSnapshot | null;
  localPlayerId: string;
  localTeam: TeamId;
  localPose: LocalPlayerPoseOverride;
  copiedCode: boolean;
  onCopyInvite: () => void;
}

export const TacticalMinimap: React.FC<TacticalMinimapProps> = ({
  map,
  localizedMapName,
  snapshot,
  localPlayerId,
  localTeam,
  localPose,
  copiedCode,
  onCopyInvite,
}) => {
  const { t } = useI18n();
  const half = map.halfSize;

  const staticTerrainLayer = useMemo(() => {
    const gridStep = half / 2;
    return (
      <g aria-hidden="true">
        {/* Arena Base Floor */}
        <rect x={-half} y={-half} width={half * 2} height={half * 2} fill="#060A11" />

        {/* Subtle Tactical Coordinate Grid */}
        <g stroke="#1E293B" strokeWidth="0.65" opacity="0.55">
          <line x1={-gridStep} y1={-half} x2={-gridStep} y2={half} />
          <line x1={0} y1={-half} x2={0} y2={half} />
          <line x1={gridStep} y1={-half} x2={gridStep} y2={half} />
          <line x1={-half} y1={-gridStep} x2={half} y2={-gridStep} />
          <line x1={-half} y1={0} x2={half} y2={0} />
          <line x1={-half} y1={gridStep} x2={half} y2={gridStep} />
        </g>

        {/* Inner Perimeter Frame */}
        <rect
          x={-half + 1}
          y={-half + 1}
          width={half * 2 - 2}
          height={half * 2 - 2}
          fill="none"
          stroke="#0E7490"
          strokeWidth="0.85"
          opacity="0.45"
        />

        {/* Static Arena Geometry: Platforms/Ramps first, then Solid Walls/Pillars */}
        {map.colliders.map((c) => {
          const isElevated = c.materialTag === 'platform' || c.materialTag === 'ramp';
          return (
            <rect
              key={c.id}
              x={c.x - c.w / 2}
              y={c.z - c.d / 2}
              width={c.w}
              height={c.d}
              fill={isElevated ? '#1E2B3E' : '#334155'}
              stroke={isElevated ? '#334155' : '#475569'}
              strokeWidth="0.45"
            />
          );
        })}
      </g>
    );
  }, [map, half]);

  const frame = useMemo(
    () => buildMinimapFrame(map, snapshot, localPlayerId, localTeam, localPose),
    [map, snapshot, localPlayerId, localTeam, localPose],
  );

  const coreStroke =
    frame.controlOwner === 'cobalt'
      ? '#06B6D4'
      : frame.controlOwner === 'amber'
        ? '#F59E0B'
        : frame.controlOwner === 'contested'
          ? '#F8FAFC'
          : '#475569';

  return (
    <div
      data-testid="tactical-minimap"
      aria-label={t.minimapAria}
      className="fixed top-4 left-4 flex flex-col gap-1.5"
    >
      <div className="chamfer-sm relative w-44 h-44 bg-[#070C14]/94 border border-cyan-500/30 p-1.5 shadow-lg">
        {/* Cardinal North Orientation Indicator */}
        <span
          aria-hidden="true"
          className="absolute top-1 left-1/2 -translate-x-1/2 text-[8px] font-mono-tabular font-bold tracking-widest text-cyan-400/80 leading-none select-none z-10"
        >
          N
        </span>

        <svg
          data-testid="minimap-svg"
          viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
          className="w-full h-full block"
          role="img"
          aria-label={t.minimapAria}
        >
          {staticTerrainLayer}

          {/* Control Core Objective Ring */}
          <circle
            cx={map.controlCore.x}
            cy={map.controlCore.z}
            r={5.2}
            fill="none"
            stroke={coreStroke}
            strokeWidth="0.95"
            strokeDasharray="2.4 1.6"
            opacity="0.75"
          />

          {/* Destructible Barriers */}
          {frame.barriers.map((b) => (
            <rect
              key={b.id}
              x={b.x - b.w / 2}
              y={b.z - b.d / 2}
              width={b.w}
              height={b.d}
              fill="#38BDF8"
              opacity={0.3 + b.hpRatio * 0.6}
            />
          ))}

          {/* Live Ore Vein Nodes */}
          {frame.oreNodes.map((o) => {
            const fill = o.depleted ? '#334155' : o.tier === 'rich' ? '#FBBF24' : '#34D399';
            return (
              <polygon
                key={o.id}
                points={`${o.x},${o.z - 2.5} ${o.x + 2.5},${o.z} ${o.x},${o.z + 2.5} ${o.x - 2.5},${o.z}`}
                fill={fill}
                stroke="#060A11"
                strokeWidth="0.55"
                opacity={o.depleted ? 0.45 : 0.95}
              />
            );
          })}

          {/* Real-Time Environmental Hazards */}
          {frame.hazards.map((h) => {
            const isCryo = h.kind === 'coolant_leak';
            const isSweeper = h.kind === 'laser_sweeper';

            if (h.phase === 'idle') {
              return (
                <g
                  key={h.id}
                  data-testid="minimap-hazard"
                  data-hazard-id={h.id}
                  data-hazard-kind={h.kind}
                  data-hazard-phase={h.phase}
                >
                  <circle
                    cx={h.x}
                    cy={h.z}
                    r={h.radius}
                    fill="none"
                    stroke="#475569"
                    strokeWidth="0.75"
                    strokeDasharray="2.2 2.2"
                    opacity="0.45"
                  />
                  <circle cx={h.x} cy={h.z} r={1.1} fill="#64748B" opacity="0.6" />
                </g>
              );
            }

            if (h.phase === 'telegraph') {
              const innerRadius = Math.max(1.2, h.radius * (0.22 + 0.78 * h.progress));
              return (
                <g
                  key={h.id}
                  data-testid="minimap-hazard"
                  data-hazard-id={h.id}
                  data-hazard-kind={h.kind}
                  data-hazard-phase={h.phase}
                >
                  <circle
                    cx={h.x}
                    cy={h.z}
                    r={h.radius}
                    fill="rgba(245, 158, 11, 0.12)"
                    stroke="#F59E0B"
                    strokeWidth="1.05"
                    strokeDasharray="3 1.8"
                    opacity="0.9"
                  />
                  <circle
                    cx={h.x}
                    cy={h.z}
                    r={innerRadius}
                    fill="none"
                    stroke="#FBBF24"
                    strokeWidth="0.8"
                    opacity="0.7"
                  />
                  {isSweeper && h.beamSegment && (
                    <line
                      x1={h.beamSegment.x1}
                      y1={h.beamSegment.z1}
                      x2={h.beamSegment.x2}
                      y2={h.beamSegment.z2}
                      stroke="#F59E0B"
                      strokeWidth="1.2"
                      strokeDasharray="2.5 2"
                      opacity="0.75"
                    />
                  )}
                  <circle cx={h.x} cy={h.z} r={1.6} fill="#F59E0B" />
                </g>
              );
            }

            // Active hazard rendering differentiated by hazard kind
            const activeFill = isCryo
              ? 'rgba(56, 189, 248, 0.28)'
              : isSweeper
                ? 'rgba(239, 68, 68, 0.08)'
                : 'rgba(239, 68, 68, 0.30)';
            const activeStroke = isCryo ? '#38BDF8' : '#EF4444';

            return (
              <g
                key={h.id}
                data-testid="minimap-hazard"
                data-hazard-id={h.id}
                data-hazard-kind={h.kind}
                data-hazard-phase={h.phase}
              >
                <circle
                  cx={h.x}
                  cy={h.z}
                  r={h.radius}
                  fill={activeFill}
                  stroke={activeStroke}
                  strokeWidth={isSweeper ? '0.95' : '1.3'}
                  opacity={isSweeper ? 0.72 : 0.95}
                />
                {!isSweeper && (
                  <circle
                    cx={h.x}
                    cy={h.z}
                    r={h.radius * 0.52}
                    fill="none"
                    stroke={isCryo ? '#BAE6FD' : '#FCA5A5'}
                    strokeWidth="0.75"
                    opacity="0.75"
                  />
                )}
                {isSweeper && h.beamSegment && (
                  <g data-testid="minimap-sweeper-beam">
                    <line
                      x1={h.beamSegment.x1}
                      y1={h.beamSegment.z1}
                      x2={h.beamSegment.x2}
                      y2={h.beamSegment.z2}
                      stroke="#EF4444"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      opacity="0.95"
                    />
                    <line
                      x1={h.beamSegment.x1}
                      y1={h.beamSegment.z1}
                      x2={h.beamSegment.x2}
                      y2={h.beamSegment.z2}
                      stroke="#FEE2E2"
                      strokeWidth="0.9"
                      strokeLinecap="round"
                    />
                  </g>
                )}
                <circle cx={h.x} cy={h.z} r={1.8} fill={activeStroke} />
              </g>
            );
          })}

          {/* Real-Time Player & Bot Positions */}
          {frame.players.map((p) => {
            if (p.relation === 'local') {
              return (
                <g
                  key={p.id}
                  data-testid="minimap-player"
                  data-player-id={p.id}
                  data-player-relation="local"
                  transform={`translate(${p.x}, ${p.z}) rotate(${p.headingDeg})`}
                >
                  {/* Directional Field-of-View Wedge */}
                  <polygon
                    points="0,0 -8.5,-16 8.5,-16"
                    fill="rgba(255, 255, 255, 0.13)"
                  />
                  {/* High-Contrast Local Player Chevron */}
                  <polygon
                    points="0,-4.2 3.0,2.7 0,1.3 -3.0,2.7"
                    fill="#FFFFFF"
                    stroke="#060A11"
                    strokeWidth="1.0"
                    paintOrder="stroke"
                  />
                </g>
              );
            }

            if (p.relation === 'ally_miner') {
              return (
                <g
                  key={p.id}
                  data-testid="minimap-player"
                  data-player-id={p.id}
                  data-player-relation="ally_miner"
                  transform={`translate(${p.x}, ${p.z})`}
                >
                  {p.isMining && (
                    <circle
                      cx={0}
                      cy={0}
                      r={3.8}
                      fill="none"
                      stroke="#34D399"
                      strokeWidth="0.7"
                      opacity="0.75"
                    />
                  )}
                  <polygon
                    points="0,-2.6 2.6,0 0,2.6 -2.6,0"
                    fill="#34D399"
                    stroke="#060A11"
                    strokeWidth="0.85"
                    paintOrder="stroke"
                  />
                </g>
              );
            }

            const markerFill =
              snapshot?.mode === 'ffa'
                ? '#FB7185'
                : p.team === 'cobalt'
                  ? '#06B6D4'
                  : '#F59E0B';

            return (
              <g
                key={p.id}
                data-testid="minimap-player"
                data-player-id={p.id}
                data-player-relation={p.relation}
                transform={`translate(${p.x}, ${p.z}) rotate(${p.headingDeg})`}
              >
                {p.shieldActive && (
                  <circle
                    cx={0}
                    cy={0}
                    r={3.4}
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="0.7"
                    opacity="0.8"
                  />
                )}
                {p.relation === 'ally' ? (
                  <polygon
                    points="0,-3.1 2.2,2.1 0,1.1 -2.2,2.1"
                    fill={markerFill}
                    stroke="#060A11"
                    strokeWidth="0.85"
                    paintOrder="stroke"
                  />
                ) : (
                  <g>
                    <circle
                      cx={0}
                      cy={0}
                      r={2.1}
                      fill={markerFill}
                      stroke="#060A11"
                      strokeWidth="0.85"
                      paintOrder="stroke"
                    />
                    <line
                      x1={0}
                      y1={-1.6}
                      x2={0}
                      y2={-3.5}
                      stroke={markerFill}
                      strokeWidth="1.0"
                      strokeLinecap="round"
                    />
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Compact Sector & Hazard Status Readout */}
      <div className="flex flex-col gap-0.5 text-[11px] font-mono-tabular text-slate-300 hud-text-stroke">
        <div className="flex items-center gap-2">
          <span>
            {localizedMapName}{snapshot?.isPrivate ? ' · ' + snapshot.roomId : ''}
          </span>
          {snapshot?.isPrivate && (
            <button
              type="button"
              onClick={onCopyInvite}
              className="pointer-events-auto px-1.5 py-0.5 bg-amber-500/20 border border-amber-400/50 text-amber-300 hover:bg-amber-500/30 text-[10px] cursor-pointer"
            >
              {copiedCode ? t.copied : t.copyCode}
            </button>
          )}
        </div>

        <div
          data-testid="minimap-hazard-status"
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider"
        >
          {frame.activeHazardCount > 0 ? (
            <span className="flex items-center gap-1 text-red-400 font-semibold">
              <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>{t.minimapHazardActive(frame.activeHazardCount)}</span>
            </span>
          ) : frame.telegraphHazardCount > 0 ? (
            <span className="flex items-center gap-1 text-amber-300 font-semibold">
              <ShieldAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>{t.minimapHazardWarn(frame.telegraphHazardCount)}</span>
            </span>
          ) : (
            <span className="text-slate-400">{t.minimapClear}</span>
          )}
        </div>
      </div>
    </div>
  );
};
