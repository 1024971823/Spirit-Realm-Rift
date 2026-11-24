import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { soundEngine } from '../audio/soundEngine';
import type { TacticalPing, TacticalPingKind } from '../shared/social';
import type { EconomyNoticePayload, GameNetworkClient } from '../net/clientSocket';
import {
  AMMO_PACKS,
  canRobotClassFire,
  COSMETICS,
  DEFAULT_LOADOUT,
  GADGETS,
  MAPS,
  normalizeControllerConfig,
  ROBOT_CLASSES,
  sanitizeLoadoutForXp,
  WEAPONS,
} from '../shared/catalog';
import {
  buildMapPropColliders,
  getActiveColliders,
  normalizeAngle,
  ORE_MINE_RADIUS,
} from '../shared/physics';
import {
  computePlayerCamera,
  MOVEMENT_STEP_SEC,
  playerMotionFromSnapshot,
  stepPlayerMotion,
  type MovementContext,
  type PlayerInput,
  type PlayerMotion,
} from '../shared/playerInput';
import type {
  AabbCollider,
  AmmoPackId,
  BeamVisualEvent,
  CombatantSnapshot,
  ControllerConfig,
  GamePhase,
  LoadoutConfig,
  MapId,
  MatchSnapshot,
  RobotClass,
  TeamId,
  Vec3,
} from '../shared/types';
import {
  type EngineAlertKey,
  formatEngineAlert,
  type Language,
  translateHazardLabel,
  UI_TEXT,
} from '../i18n/translations';
import {
  buildCentralLandmark,
  buildDestructibleBarrier,
  buildHazardAssembly,
  buildOreNodeAssembly,
  buildRoboMasterCombatantRig,
  type RoboMasterCombatantRig,
} from './models';
import { preloadAllRoboMasterTemplates } from './robomasterModel';
import { createArenaTextures, type ProceduralTextureSet } from './textures';
import { TACTICAL_KEYS, TACTICAL_PINGS, tacticalDirection } from './tacticalPings';

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const VENT_COOLDOWN_MS = 1600;

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
}

type TacticalMenu = {
  source: 'keyboard' | 'gamepad';
  kind: TacticalPingKind | 'none';
  dx: number;
  dy: number;
  cursor: { x: number; y: number } | null;
};

export interface NearbyOreHudInfo {
  id: string;
  label: string;
  amount: number;
  maxAmount: number;
  tier: 'standard' | 'rich';
  dist: number;
}

export interface HudLiveState {
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  ammo: number;
  maxAmmo: number;
  robotClass: RobotClass;
  teamCredits: number;
  heat: number;
  overheated: boolean;
  gadgetCooldown: number;
  gadgetMaxCooldown: number;
  dashCooldown: number;
  classSkillCooldown: number;
  classSkillMaxCooldown: number;
  overclockActive: boolean;
  overclockRemainingSec: number;
  isMining: boolean;
  nearbyOreNode: NearbyOreHudInfo | null;
  economyAlert: string | null;
  alive: boolean;
  respawnSec: number;
  slowed: boolean;
  shielded: boolean;
  hitmarkerActive: boolean;
  hitmarkerKilled: boolean;
  damageFlash: number;
  hazardWarning: string | null;
  pointerLocked: boolean;
  gamepadName: string | null;
  playerPos: Vec3;
  playerYaw: number;
  tacticalMenu?: TacticalPingKind | 'none';
  tacticalPings?: TacticalPing[];
}

interface PooledParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  scale: number;
  color: THREE.Color;
}

interface PooledBeam {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
}

interface RemoteActor {
  id: string;
  team: TeamId;
  robotClass: RobotClass;
  isBot: boolean;
  skinHex: string;
  beamHex: string;
  rig: RoboMasterCombatantRig;
  previousPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  previousChassisYaw: number;
  previousAimYaw: number;
  previousPitch: number;
  targetChassisYaw: number;
  targetAimYaw: number;
  targetPitch: number;
  chassisYaw: number;
  aimYaw: number;
  aimPitch: number;
  isMining: boolean;
  isOverclocked: boolean;
  miningNodeId: string | null;
  lastSnapshotMs: number;
}

export interface EngineCallbacks {
  onHudUpdate: (hud: HudLiveState) => void;
  onVoicePttChange: (active: boolean) => void;
  onQuickSwitchClass?: (nextClass: RobotClass) => void;
}

export class LaserTagEngine {
  private container: HTMLElement;
  private network: GameNetworkClient;
  private callbacks: EngineCallbacks;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;
  private textures: ProceduralTextureSet | null = null;

  private arenaGroup = new THREE.Group();
  private barrierVisuals = new Map<string, ReturnType<typeof buildDestructibleBarrier>>();
  private hazardVisuals = new Map<string, ReturnType<typeof buildHazardAssembly>>();
  private oreVisuals = new Map<string, ReturnType<typeof buildOreNodeAssembly>>();
  private centralSpinner: THREE.Group | null = null;
  private centralInnerSpinner: THREE.Group | null = null;

  private localRobotRig: RoboMasterCombatantRig | null = null;
  private localRigMeta: { robotClass: RobotClass; team: TeamId; skinHex: string; beamHex: string } | null = null;
  private localChassisYaw = -Math.PI / 2;

  private remoteActors = new Map<string, RemoteActor>();

  // Particle, Beam & Mining Tether pools
  private particleMesh: THREE.InstancedMesh;
  private particles: PooledParticle[] = [];
  private particleCursor = 0;
  private beamPool: PooledBeam[] = [];
  private beamCursor = 0;
  private miningBeamPool: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }> = [];

  // Simulation state
  private phase: GamePhase = 'title';
  private localPlayerId = '';
  private currentMapId: MapId = 'reactor_foundry';
  private latestSnapshot: MatchSnapshot | null = null;
  private loadout: LoadoutConfig;
  private controller: ControllerConfig;

  private playerPos = new THREE.Vector3(-42, 0, 0);
  private predictedMotion: PlayerMotion | null = null;
  private pendingInputs: PlayerInput[] = [];
  private nextInputSeq = 1;
  private nextActionSeq = 1;
  private activeMatchId: string | undefined;
  private latestServerTick = -1;
  private inputClock = 0;
  private wantsDash = false;
  private yaw = -Math.PI / 2;
  private pitch = -0.04;
  private targetYaw = -Math.PI / 2;
  private targetPitch = -0.04;
  private pendingLookDx = 0;
  private pendingLookDy = 0;

  private heat = 0;
  private overheated = false;
  private lastShotMs = 0;
  private lastVentMs = -VENT_COOLDOWN_MS;
  private lastNoAmmoCueMs = 0;
  private lastMineSentMs = 0;
  private lastMineSparkMs = 0;
  private dashTimer = 0;
  private dashCooldown = 0;
  private gadgetCooldown = 0;
  private classSkillCooldown = 0;
  private localOverclockUntil = 0;
  private localMiningActive = false;
  private nearbyOreNode: NearbyOreHudInfo | null = null;
  private economyAlertState: { key: EngineAlertKey; packId?: AmmoPackId } | null = null;
  private economyAlertUntil = 0;
  private lang: Language = 'zh';

  private trauma = 0;
  private hitstopTimer = 0;
  private hitmarkerTimer = 0;
  private hitmarkerKilled = false;
  private damageFlash = 0;
  private prevHpTotal = 150;
  private prevLocalAlive = true;
  private lastHazardTelegraphSound = 0;

  // Input state
  private keys = new Set<string>();
  private mouseDown = false;
  private adsActive = false;
  private gamepadAds = false;
  private draggingLook = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pointerLocked = false;
  private gamepadName: string | null = null;
  private gamepadPingHeld = false;
  private tacticalMenu: TacticalMenu | null = null;
  private tacticalPings = new Map<string, { ping: TacticalPing; marker: THREE.Group }>();
  private tacticalBlockedIds = new Set<string>();

  private cachedColliders: AabbCollider[] = [];
  private cachedCollidersKey = '';
  private cachedPropCollidersMapId: MapId | null = null;
  private cachedPropColliders: AabbCollider[] = [];
  private otherRobotScratch: Vec3[] = [];
  private needsShaderCompile = false;
  private lastShaderCompileMs = 0;

  private frameId = 0;
  private lastFrameTime = performance.now();
  private lastHudPush = 0;
  private titleOrbitAngle = 0.4;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private contextLost = false;
  private disposed = false;

  constructor(
    container: HTMLElement,
    network: GameNetworkClient,
    localPlayerId: string,
    loadout: LoadoutConfig,
    controller: ControllerConfig,
    callbacks: EngineCallbacks,
  ) {
    this.container = container;
    this.network = network;
    this.localPlayerId = localPlayerId;
    this.loadout = sanitizeLoadoutForXp(loadout, DEFAULT_LOADOUT, Number.MAX_SAFE_INTEGER);
    this.controller = normalizeControllerConfig(controller);
    this.callbacks = callbacks;

    // 1. Software WebGL probe
    this.isSoftwareGl = (() => {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    // 2. Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // 3. Scene & Camera
    this.scene = new THREE.Scene();
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(this.controller.fov, w / h, 0.1, 300);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // 4. Mandatory RoomEnvironment PMREM
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.envRenderTarget = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRenderTarget.texture;
    envScene.dispose();
    pmrem.dispose();

    // 5. Pooled InstancedMesh Particles (112 capacity)
    const pGeo = new THREE.OctahedronGeometry(0.14, 0);
    const pMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.particleMesh = new THREE.InstancedMesh(pGeo, pMat, 112);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.frustumCulled = false;
    for (let i = 0; i < 112; i++) {
      this.particles.push({
        active: false,
        x: 0,
        y: -50,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 0.4,
        scale: 0,
        color: new THREE.Color(0x06b6d4),
      });
      _mat4.makeScale(0, 0, 0);
      this.particleMesh.setMatrixAt(i, _mat4);
      this.particleMesh.setColorAt(i, new THREE.Color(0x06b6d4));
    }
    this.particleMesh.computeBoundingSphere();
    this.scene.add(this.particleMesh);

    // 6. Pooled Laser Beam Tracers (20 capacity)
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
    beamGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.beamPool.push({ mesh, mat, life: 0, maxLife: 0.14 });
    }

    // 7. Pooled Ore Mining Extraction Beams (10 capacity)
    const mineGeo = new THREE.CylinderGeometry(0.055, 0.085, 1, 6);
    mineGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.85 });
      const mesh = new THREE.Mesh(mineGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.miningBeamPool.push({ mesh, mat });
    }

    // 8. Build initial arena & preload both RoboMaster S1 & EP URDF meshes
    this.scene.add(this.arenaGroup);
    this.buildArena(this.currentMapId);
    this.ensureLocalRobotRig();
    preloadAllRoboMasterTemplates();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.frameId = requestAnimationFrame(this.tick);
  }

  setPhase(phase: GamePhase): void {
    const prev = this.phase;
    if (prev === phase) return;
    this.phase = phase;
    this.closeTacticalMenu();
    if (phase === 'title' || phase === 'gameover') this.clearTacticalPings();
    this.keys.clear();
    this.mouseDown = false;
    this.adsActive = false;
    this.gamepadAds = false;
    this.wantsDash = false;
    this.inputClock = 0;

    if (phase === 'playing') {
      if (prev === 'title') {
        this.syncSpawnFromSnapshot();
      }
    } else {
      if (prev === 'playing' && phase === 'paused') this.sendMovementInput(0, 0);
      if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock?.();
    }
    this.ensureLocalRobotRig();
  }

  syncToRoomJoin(snap: MatchSnapshot): void {
    this.closeTacticalMenu();
    this.clearTacticalPings();
    this.heat = 0;
    this.overheated = false;
    this.gadgetCooldown = 0;
    this.dashCooldown = 0;
    this.classSkillCooldown = 0;
    this.dashTimer = 0;
    this.localOverclockUntil = 0;
    this.lastShotMs = 0;
    this.lastVentMs = -VENT_COOLDOWN_MS;
    this.lastMineSentMs = 0;
    this.prevHpTotal = 150;
    this.prevLocalAlive = true;
    this.pendingInputs = [];
    this.nextActionSeq = 1;
    this.activeMatchId = snap.matchId;
    this.latestServerTick = -1;
    this.nextInputSeq = (snap.players.find((p) => p.id === this.localPlayerId)?.lastProcessedInputSeq ?? 0) + 1;
    this.inputClock = 0;
    this.wantsDash = false;
    this.applySnapshot(snap);
    this.syncSpawnFromSnapshot();
  }

  setIdentity(playerId: string): void {
    if (this.localPlayerId !== playerId) {
      this.closeTacticalMenu();
      this.clearTacticalPings();
    }
    this.localPlayerId = playerId;
  }

  updateConfig(loadout: LoadoutConfig, controller: ControllerConfig): void {
    const safeLoadout = sanitizeLoadoutForXp(loadout, this.loadout, Number.MAX_SAFE_INTEGER);
    const safeController = normalizeControllerConfig(controller);
    const classChanged = safeLoadout.robotClass !== this.loadout.robotClass;
    const weaponChanged = safeLoadout.weaponId !== this.loadout.weaponId;
    const rigVisualChanged =
      classChanged ||
      safeLoadout.skinId !== this.loadout.skinId ||
      safeLoadout.beamColorId !== this.loadout.beamColorId;
    this.loadout = safeLoadout;
    this.controller = safeController;
    if (this.camera.fov !== safeController.fov && !this.adsActive) {
      this.camera.fov = safeController.fov;
      this.camera.updateProjectionMatrix();
    }
    if (rigVisualChanged) {
      this.ensureLocalRobotRig();
    }
    if (classChanged || weaponChanged || rigVisualChanged) {
      this.lastHudPush = performance.now();
      this.emitHudState();
    }
  }

  setLanguage(lang: Language): void {
    this.lang = lang;
    this.emitHudState();
  }

  buyAmmoPack(packId: AmmoPackId): void {
    if (this.phase !== 'playing') return;
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    if (!canRobotClassFire(this.getEffectiveLocalRobotClass(me)) && (packId === 'light_mag' || packId === 'full_mag')) {
      this.setEconomyAlert('ep_unarmed_credits');
      return;
    }
    this.sendAction('player:buy_ammo', { packId });
  }

  smartBuyAmmo(): void {
    if (this.phase !== 'playing') return;
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    if (!canRobotClassFire(this.getEffectiveLocalRobotClass(me))) {
      this.setEconomyAlert('ep_unarmed_credits');
      return;
    }
    const credits = this.getLocalTeamCredits(me?.team);
    if (credits >= AMMO_PACKS.full_mag.cost) {
      this.buyAmmoPack('full_mag');
    } else if (credits >= AMMO_PACKS.light_mag.cost) {
      this.buyAmmoPack('light_mag');
    } else {
      this.setEconomyAlert('insufficient_credits');
      soundEngine.playHazardTelegraph();
    }
  }

  triggerClassSkillPublic(): void {
    this.triggerClassSkill();
  }

  handleEconomyNotice(notice: EconomyNoticePayload): void {
    if (notice.ok) {
      if (notice.resetHeat) {
        this.heat = 0;
        this.overheated = false;
      }
      this.setEconomyAlert('resupplied', notice.packId);
      soundEngine.playDash();
    } else {
      const key: EngineAlertKey =
        notice.reason === 'ep_no_weapon'
          ? 'ep_no_weapon'
          : notice.reason === 'insufficient_credits'
            ? 'low_team_credits'
            : notice.reason === 'already_full'
              ? 'already_full'
              : notice.reason === 'no_ammo'
                ? 'no_ammo'
                : 'supply_unavailable';
      this.setEconomyAlert(key);
      if (notice.reason !== 'ep_no_weapon') {
        soundEngine.playHazardTelegraph();
      }
    }
  }

  private setEconomyAlert(key: EngineAlertKey, packId?: AmmoPackId): void {
    this.economyAlertState = { key, packId };
    this.economyAlertUntil = performance.now() + 2400;
  }

  private getLocalTeamCredits(team?: TeamId): number {
    if (!this.latestSnapshot) return 0;
    const t = team ?? 'cobalt';
    return t === 'amber' ? this.latestSnapshot.teamCreditsAmber : this.latestSnapshot.teamCreditsCobalt;
  }

  private getEffectiveLocalRobotClass(me?: CombatantSnapshot): RobotClass {
    return (this.phase === 'title' ? undefined : me?.robotClass) ?? this.loadout.robotClass;
  }

  private ensureLocalRobotRig(): void {
    if (!this.textures) return;
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    const team: TeamId = me?.team ?? 'cobalt';
    const robotClass: RobotClass = this.getEffectiveLocalRobotClass(me);
    const skinHex = COSMETICS.find((c) => c.id === this.loadout.skinId)?.hex || '#262F3F';
    const beamHex = COSMETICS.find((c) => c.id === this.loadout.beamColorId)?.hex || '#06B6D4';

    const meta = this.localRigMeta;
    const changed =
      !this.localRobotRig ||
      !meta ||
      meta.robotClass !== robotClass ||
      meta.team !== team ||
      meta.skinHex !== skinHex ||
      meta.beamHex !== beamHex;

    if (changed) {
      if (this.localRobotRig) {
        this.scene.remove(this.localRobotRig.root);
        this.disposeRobotRig(this.localRobotRig);
      }
      this.localRobotRig = buildRoboMasterCombatantRig(
        robotClass,
        team,
        skinHex,
        beamHex,
        false,
        this.textures.contactShadowMap,
        () => {
          this.needsShaderCompile = true;
        },
      );
      this.localRobotRig.root.position.copy(this.playerPos);
      this.localRobotRig.root.rotation.y = this.localChassisYaw;
      this.scene.add(this.localRobotRig.root);
      this.localRigMeta = { robotClass, team, skinHex, beamHex };
    }

    if (this.localRobotRig) {
      const alive = me ? me.alive : true;
      this.localRobotRig.root.visible = this.phase !== 'title' && alive;
      this.localRobotRig.shieldDome.visible = Boolean(me?.shieldActive);
    }
  }

  applySnapshot(snap: MatchSnapshot): void {
    if (snap.matchId !== this.activeMatchId) {
      this.closeTacticalMenu();
      this.clearTacticalPings();
      this.activeMatchId = snap.matchId;
      this.latestServerTick = -1;
      this.pendingInputs = [];
      this.nextInputSeq = 1;
      this.nextActionSeq = 1;
    }
    if (snap.matchId && snap.serverTick !== undefined) {
      if (snap.serverTick < this.latestServerTick) return;
      this.latestServerTick = snap.serverTick;
    }
    const previousTeam = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId)?.team;
    const local = snap.players.find((p) => p.id === this.localPlayerId);
    this.latestSnapshot = snap;
    if (!local?.alive || snap.phase !== 'active') this.closeTacticalMenu();
    if (!local || local.team !== previousTeam || snap.phase !== 'active') this.clearTacticalPings();
    if (snap.mapId !== this.currentMapId) {
      this.buildArena(snap.mapId);
    }

    // 1. Update destructible barriers visibility & damage tint
    const map = MAPS[this.currentMapId];
    for (const bState of snap.barriers) {
      const vis = this.barrierVisuals.get(bState.id);
      if (!vis) continue;
      vis.group.visible = !bState.destroyed;
      const hpRatio = bState.hp / Math.max(1, bState.maxHp);
      vis.coreMat.opacity = 0.35 + hpRatio * 0.5;
      if (hpRatio < 0.4) {
        vis.coreMat.emissive.setHex(0xef4444);
      } else {
        vis.coreMat.emissive.setHex(0x0284c7);
      }
    }

    // 2. Update ore veins crystal fill & depleted appearance
    for (const ore of snap.oreNodes) {
      const vis = this.oreVisuals.get(ore.id);
      if (!vis) continue;
      const frac = ore.depleted ? 0.14 : Math.max(0.24, ore.amount / Math.max(1, ore.maxAmount));
      vis.crystalGroup.scale.set(0.55 + frac * 0.45, 0.25 + frac * 0.85, 0.55 + frac * 0.45);
      vis.crystalMat.emissiveIntensity = ore.depleted ? 0.18 : ore.tier === 'rich' ? 1.25 : 0.95;
      vis.ringMat.opacity = ore.depleted ? 0.12 : 0.42;
      vis.haloMesh.visible = !ore.depleted;
    }

    // 3. Update hazards telegraph/active visuals
    for (let i = 0; i < map.hazards.length; i++) {
      const def = map.hazards[i];
      const rt = snap.hazards[i];
      const vis = this.hazardVisuals.get(def.id);
      if (!vis || !rt) continue;

      if (rt.phase === 'idle') {
        vis.ringMat.opacity = 0.14;
        if (vis.sweeperBeam) vis.sweeperBeam.visible = false;
      } else if (rt.phase === 'telegraph') {
        vis.ringMat.opacity = 0.35 + Math.sin(performance.now() * 0.025) * 0.25;
        if (vis.sweeperBeam) {
          vis.sweeperBeam.visible = true;
          (vis.sweeperBeam.material as THREE.MeshBasicMaterial).opacity = 0.25;
          vis.coreMesh.rotation.y = -rt.sweepAngle;
        }
        const now = performance.now();
        if (now - this.lastHazardTelegraphSound > 2400 && this.phase === 'playing') {
          const dist = Math.hypot(this.playerPos.x - def.x, this.playerPos.z - def.z);
          if (dist < def.radius + 5) {
            this.lastHazardTelegraphSound = now;
            soundEngine.playHazardTelegraph();
          }
        }
      } else {
        vis.ringMat.opacity = 0.78;
        if (vis.sweeperBeam) {
          vis.sweeperBeam.visible = true;
          (vis.sweeperBeam.material as THREE.MeshBasicMaterial).opacity = 0.92;
          vis.coreMesh.rotation.y = -rt.sweepAngle;
        }
      }
    }

    // 4. Sync local player stats / damage feedback & remote combatants
    const nowPerf = performance.now();
    const seenIds = new Set<string>();
    for (const p of snap.players) {
      if (p.id === this.localPlayerId) {
        const total = p.hp + p.shield;
        if (total < this.prevHpTotal && this.phase === 'playing') {
          this.damageFlash = 0.75;
          this.trauma = Math.min(1, this.trauma + 0.35);
          soundEngine.playHurt();
          this.triggerHaptic(0.45, 0.25, 110);
        }
        this.prevHpTotal = total;

        const respawned = !this.prevLocalAlive && p.alive;
        this.prevLocalAlive = p.alive;
        const acknowledged = p.lastProcessedInputSeq ?? 0;
        this.nextInputSeq = Math.max(this.nextInputSeq, acknowledged + 1);
        this.pendingInputs = !p.alive || respawned ? [] : this.pendingInputs.filter((input) => input.seq > acknowledged);
        let predicted = playerMotionFromSnapshot(p);
        const context = this.getMovementContext(p, snap);
        for (const input of this.pendingInputs) predicted = stepPlayerMotion(predicted, input, context);
        this.predictedMotion = predicted;
        this.dashTimer = predicted.dashRemaining;
        this.dashCooldown = predicted.dashCooldown;
        this.heat = p.heat ?? this.heat;
        this.overheated = p.overheated ?? this.overheated;
        this.gadgetCooldown = p.gadgetCooldown ?? this.gadgetCooldown;
        this.classSkillCooldown = p.classSkillCooldown ?? this.classSkillCooldown;

        if (respawned || !p.alive || this.phase !== 'playing') {
          this.playerPos.set(p.x, p.y, p.z);
          this.localChassisYaw = predicted.chassisYaw;
        }
        if (respawned) {
          this.yaw = this.targetYaw = p.yaw;
          this.pitch = this.targetPitch = p.pitch;
          this.pendingLookDx = this.pendingLookDy = 0;
        }
        continue;
      }

      seenIds.add(p.id);
      let actor = this.remoteActors.get(p.id);
      if (
        !actor ||
        actor.team !== p.team ||
        actor.skinHex !== p.skinHex ||
        actor.robotClass !== p.robotClass
      ) {
        if (actor) {
          this.scene.remove(actor.rig.root);
          this.disposeRobotRig(actor.rig);
        }
        const rig = buildRoboMasterCombatantRig(
          p.robotClass,
          p.team,
          p.skinHex,
          p.beamHex,
          p.isBot,
          this.textures!.contactShadowMap,
          () => {
            this.needsShaderCompile = true;
          },
        );
        const initChassis = p.chassisYaw ?? p.yaw;
        rig.root.position.set(p.x, p.y, p.z);
        rig.root.rotation.y = initChassis;
        this.scene.add(rig.root);
        actor = {
          id: p.id,
          team: p.team,
          robotClass: p.robotClass,
          isBot: p.isBot,
          skinHex: p.skinHex,
          beamHex: p.beamHex,
          rig,
          previousPos: new THREE.Vector3(p.x, p.y, p.z),
          targetPos: new THREE.Vector3(p.x, p.y, p.z),
          previousChassisYaw: initChassis,
          previousAimYaw: p.yaw,
          previousPitch: p.pitch,
          targetChassisYaw: initChassis,
          targetAimYaw: p.yaw,
          targetPitch: p.pitch,
          chassisYaw: initChassis,
          aimYaw: p.yaw,
          aimPitch: p.pitch,
          isMining: Boolean(p.miningNodeId),
          isOverclocked: p.overclocked,
          miningNodeId: p.miningNodeId,
          lastSnapshotMs: nowPerf,
        };
        this.remoteActors.set(p.id, actor);
      }

      const prevAlive = actor.rig.root.visible;
      actor.previousPos.copy(actor.rig.root.position);
      actor.previousChassisYaw = actor.chassisYaw;
      actor.previousAimYaw = actor.aimYaw;
      actor.previousPitch = actor.aimPitch;
      actor.targetPos.set(p.x, p.y, p.z);
      actor.targetChassisYaw = p.chassisYaw ?? p.yaw;
      actor.targetAimYaw = p.yaw;
      actor.targetPitch = p.pitch;
      actor.isMining = Boolean(p.miningNodeId);
      actor.isOverclocked = p.overclocked;
      actor.miningNodeId = p.miningNodeId;
      actor.lastSnapshotMs = nowPerf;
      actor.rig.root.visible = p.alive;
      actor.rig.shieldDome.visible = p.shieldActive;

      // Snap position cleanly when respawning so robot doesn't slide from death spot
      if ((!prevAlive && p.alive) || actor.previousPos.distanceTo(actor.targetPos) > 8.5) {
        actor.rig.root.position.set(p.x, p.y, p.z);
        actor.previousPos.copy(actor.targetPos);
        actor.chassisYaw = actor.targetChassisYaw;
        actor.aimYaw = actor.targetAimYaw;
        actor.aimPitch = actor.targetPitch;
        actor.previousChassisYaw = actor.targetChassisYaw;
        actor.previousAimYaw = actor.targetAimYaw;
        actor.previousPitch = actor.targetPitch;
        actor.rig.root.rotation.y = actor.chassisYaw;
      }
    }

    for (const [id, actor] of this.remoteActors.entries()) {
      if (!seenIds.has(id)) {
        this.scene.remove(actor.rig.root);
        this.disposeRobotRig(actor.rig);
        this.remoteActors.delete(id);
      }
    }

    this.ensureLocalRobotRig();
  }

  showTacticalPing(ping: TacticalPing): void {
    const snapshot = this.latestSnapshot;
    const local = snapshot?.players.find((player) => player.id === this.localPlayerId);
    if (!local || !snapshot?.matchId || snapshot.matchId !== ping.matchId || !this.isTeamMatch(snapshot) ||
        snapshot.phase !== 'active' || local.team !== ping.team || this.tacticalBlockedIds.has(ping.playerId) ||
        !Object.hasOwn(TACTICAL_PINGS, ping.kind) || ping.expiresAt <= Date.now() ||
        ![ping.position.x, ping.position.y, ping.position.z, ping.expiresAt].every(Number.isFinite)) return;
    if ((this.tacticalPings.get(ping.playerId)?.ping.expiresAt ?? 0) >= ping.expiresAt) return;

    this.removeTacticalPing(ping.playerId);
    const marker = new THREE.Group();
    marker.name = 'tactical-ping';
    marker.position.set(ping.position.x, ping.position.y, ping.position.z);
    const mat = new THREE.MeshBasicMaterial({ color: TACTICAL_PINGS[ping.kind].color });
    if (ping.kind === 'support') {
      const horizontal = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.18, 0.18), mat);
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.65, 0.18), mat);
      horizontal.position.y = vertical.position.y = 0.85;
      marker.add(horizontal, vertical);
    } else {
      const geometry = ping.kind === 'danger'
        ? new THREE.ConeGeometry(0.34, 0.62, 3)
        : new THREE.OctahedronGeometry(ping.kind === 'rally' ? 0.36 : 0.3);
      const badge = new THREE.Mesh(geometry, mat);
      if (ping.kind === 'mine') badge.scale.y = 0.65;
      badge.position.y = 0.85;
      marker.add(badge);
    }
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.55, 5), mat);
    stem.position.y = 0.28;
    marker.add(stem);
    this.scene.add(marker);
    this.tacticalPings.set(ping.playerId, { ping, marker });
    this.emitHudState();
  }

  setTacticalBlockedIds(ids: readonly string[]): void {
    this.tacticalBlockedIds = new Set(ids);
    let changed = false;
    for (const playerId of this.tacticalPings.keys()) {
      if (this.tacticalBlockedIds.has(playerId)) {
        this.removeTacticalPing(playerId);
        changed = true;
      }
    }
    if (changed) this.emitHudState();
  }

  private removeTacticalPing(playerId: string): void {
    const entry = this.tacticalPings.get(playerId);
    if (!entry) return;
    this.scene.remove(entry.marker);
    this.disposeObject3D(entry.marker);
    this.tacticalPings.delete(playerId);
  }

  private clearTacticalPings(): void {
    for (const playerId of this.tacticalPings.keys()) this.removeTacticalPing(playerId);
  }

  private isTeamMatch(snapshot: MatchSnapshot): boolean {
    return snapshot.mode !== 'ffa';
  }

  private openTacticalMenu(source: TacticalMenu['source']): boolean {
    if (this.tacticalMenu) return false;
    const snap = this.latestSnapshot;
    if (this.phase !== 'playing' || !snap?.matchId || snap.phase !== 'active' ||
        !this.isTeamMatch(snap) || !snap.players.some((player) => player.id === this.localPlayerId && player.alive) ||
        isEditable(document.activeElement)) return false;
    this.tacticalMenu = { source, kind: 'none', dx: 0, dy: 0, cursor: null };
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.pendingLookDx = this.pendingLookDy = 0;
    this.mouseDown = this.draggingLook = this.adsActive = this.gamepadAds = this.wantsDash = false;
    this.keys.clear();
    this.localMiningActive = false;
    this.emitHudState();
    return true;
  }

  private selectTacticalKind(kind: TacticalPingKind): void {
    if (!this.tacticalMenu || this.tacticalMenu.kind === kind) return;
    this.tacticalMenu.kind = kind;
    this.emitHudState();
  }

  private closeTacticalMenu(send = false): void {
    const menu = this.tacticalMenu;
    if (!menu) return;
    this.tacticalMenu = null;
    if (send && menu.kind !== 'none' && !isEditable(document.activeElement)) {
      this.sendAction('player:ping', { kind: menu.kind, yaw: this.yaw, pitch: this.pitch });
    }
    this.emitHudState();
  }

  spawnBeamVisual(beam: BeamVisualEvent): void {
    const slot = this.beamPool[this.beamCursor];
    this.beamCursor = (this.beamCursor + 1) % this.beamPool.length;

    let startX = beam.start.x;
    let startY = beam.start.y;
    let startZ = beam.start.z;

    if (beam.shooterId === this.localPlayerId && this.localRobotRig) {
      this.localRobotRig.root.updateMatrixWorld(true);
      this.localRobotRig.getMuzzleWorldPos(_vec3A);
      startX = _vec3A.x;
      startY = _vec3A.y;
      startZ = _vec3A.z;
    } else {
      const actor = this.remoteActors.get(beam.shooterId);
      if (actor) {
        actor.rig.root.updateMatrixWorld(true);
        actor.rig.getMuzzleWorldPos(_vec3A);
        startX = _vec3A.x;
        startY = _vec3A.y;
        startZ = _vec3A.z;
      }
    }

    _vec3A.set(startX, startY, startZ);
    _vec3B.set(beam.end.x, beam.end.y, beam.end.z);
    const dist = Math.max(0.2, _vec3A.distanceTo(_vec3B));

    slot.mesh.position.copy(_vec3A).lerp(_vec3B, 0.5);
    slot.mesh.lookAt(_vec3B);
    slot.mesh.scale.set(beam.width, beam.width, dist);
    slot.mat.color.set(beam.colorHex);
    slot.mat.opacity = 0.95;
    slot.mesh.visible = true;
    slot.life = slot.maxLife;

    this.spawnParticles(beam.end, beam.colorHex, 6, 4.5);
  }

  onHitConfirmed(killed: boolean): void {
    this.hitmarkerTimer = killed ? 0.28 : 0.14;
    this.hitmarkerKilled = killed;
    soundEngine.playHitmarker(killed);
    this.triggerHaptic(killed ? 0.6 : 0.25, killed ? 0.5 : 0.15, killed ? 120 : 60);
    if (killed) {
      this.hitstopTimer = 0.045;
      this.trauma = Math.min(1, this.trauma + 0.3);
    }
  }

  onBarrierShattered(barrierId: string): void {
    const map = MAPS[this.currentMapId];
    const def = map.barriers.find((b) => b.id === barrierId);
    if (def) {
      this.spawnParticles({ x: def.x, y: def.y, z: def.z }, '#38BDF8', 20, 8.5);
      soundEngine.playBarrierShatter();
      this.hitstopTimer = 0.04;
      this.trauma = Math.min(1, this.trauma + 0.25);
    }
  }

  requestPointerLock(): void {
    if (this.phase === 'playing' && document.pointerLockElement !== this.renderer.domElement) {
      try {
        const res = this.renderer.domElement.requestPointerLock?.() as unknown;
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // Ignore pointer-lock security errors in restricted iframes
      }
    }
  }

  private syncSpawnFromSnapshot(): void {
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    if (me) {
      this.playerPos.set(me.x, me.y, me.z);
      this.yaw = me.yaw;
      this.targetYaw = me.yaw;
      this.localChassisYaw = me.chassisYaw ?? me.yaw;
      this.pitch = this.targetPitch = me.pitch;
      this.predictedMotion = playerMotionFromSnapshot(me);
    } else {
      const sp = MAPS[this.currentMapId].spawns[0];
      this.playerPos.set(sp.x, sp.y, sp.z);
      this.yaw = sp.yaw;
      this.targetYaw = sp.yaw;
      this.localChassisYaw = sp.yaw;
      this.pitch = -0.04;
      this.targetPitch = -0.04;
      this.predictedMotion = null;
    }
    this.pendingLookDx = 0;
    this.pendingLookDy = 0;
    this.ensureLocalRobotRig();
  }

  private getMovementContext(me: CombatantSnapshot, snapshot: MatchSnapshot): MovementContext {
    this.otherRobotScratch.length = 0;
    for (const other of snapshot.players) {
      if (other.alive && other.id !== me.id) this.otherRobotScratch.push(other);
    }
    return {
      colliders: this.getActiveCollidersCached(),
      halfSize: MAPS[snapshot.mapId].halfSize,
      otherRobots: this.otherRobotScratch,
      speedMult: ROBOT_CLASSES[me.robotClass].speedMult,
      slowed: me.slowedUntil > (snapshot.serverTimeMs ?? Date.now()),
      lastAimYaw: me.yaw,
    };
  }

  private sendMovementInput(moveX: number, moveZ: number): void {
    const snapshot = this.latestSnapshot;
    const matchId = snapshot?.matchId;
    const me = snapshot?.players.find((p) => p.id === this.localPlayerId);
    if (!matchId || snapshot?.phase !== 'active' || !me?.alive || !this.predictedMotion) return;

    const input: PlayerInput = {
      matchId, seq: this.nextInputSeq, moveX, moveZ,
      yaw: this.yaw, pitch: this.pitch, ads: this.adsActive || this.gamepadAds,
      dash: this.wantsDash,
    };
    if (this.pendingInputs.length >= 16 || !this.network.send('player:input', input)) return;
    this.nextInputSeq++;
    this.wantsDash = false;
    this.predictedMotion = stepPlayerMotion(this.predictedMotion, input, this.getMovementContext(me, snapshot));
    this.pendingInputs.push(input);
    this.dashTimer = this.predictedMotion.dashRemaining;
    this.dashCooldown = this.predictedMotion.dashCooldown;
  }

  private sendAction(type: string, extra: Record<string, unknown> = {}): boolean {
    const matchId = this.latestSnapshot?.matchId;
    if (this.phase !== 'playing' || this.tacticalMenu || !matchId || this.latestSnapshot?.phase !== 'active' ||
        !this.latestSnapshot.players.some((p) => p.id === this.localPlayerId && p.alive)) return false;
    return this.network.send(type, { ...extra, matchId, actionSeq: this.nextActionSeq++ });
  }

  private getActiveCollidersCached(): AabbCollider[] {
    const map = MAPS[this.currentMapId];
    if (this.cachedPropCollidersMapId !== map.id) {
      this.cachedPropCollidersMapId = map.id;
      this.cachedPropColliders = buildMapPropColliders(map);
    }
    const barriers = this.latestSnapshot?.barriers || [];
    let key = this.currentMapId;
    for (let i = 0; i < barriers.length; i++) {
      key += barriers[i].destroyed ? '1' : '0';
    }
    if (key !== this.cachedCollidersKey || this.cachedColliders.length === 0) {
      this.cachedCollidersKey = key;
      this.cachedColliders = getActiveColliders(
        map.colliders,
        map.barriers,
        barriers,
        this.cachedPropColliders,
      );
    }
    return this.cachedColliders;
  }

  private disposeRobotRig(rig: RoboMasterCombatantRig): void {
    rig.disposeModelLoad();
    this.disposeObject3D(rig.root);
  }

  private disposeObject3D(root: THREE.Object3D): void {
    root.userData.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry && !mesh.geometry.userData?.sharedUrdfGeometry) {
        geometries.add(mesh.geometry);
      }
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => {
            if (!m.userData?.sharedUrdfMaterial) materials.add(m);
          });
        } else if (!mesh.material.userData?.sharedUrdfMaterial) {
          materials.add(mesh.material);
        }
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  }

  private buildArena(mapId: MapId): void {
    this.currentMapId = mapId in MAPS ? mapId : 'reactor_foundry';
    const map = MAPS[this.currentMapId];

    // Clear & dispose previous arena objects and actor rigs referencing old contactShadowMap
    while (this.arenaGroup.children.length > 0) {
      const child = this.arenaGroup.children[0];
      this.arenaGroup.remove(child);
      this.disposeObject3D(child);
    }
    for (const actor of this.remoteActors.values()) {
      this.scene.remove(actor.rig.root);
      this.disposeRobotRig(actor.rig);
    }
    this.remoteActors.clear();
    if (this.localRobotRig) {
      this.scene.remove(this.localRobotRig.root);
      this.disposeRobotRig(this.localRobotRig);
      this.localRobotRig = null;
      this.localRigMeta = null;
    }

    this.barrierVisuals.clear();
    this.hazardVisuals.clear();
    this.oreVisuals.clear();
    this.textures?.dispose();

    this.scene.background = new THREE.Color(map.fogColor);
    this.scene.fog = new THREE.FogExp2(map.fogColor, 0.0072);

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.textures = createArenaTextures(maxAniso, map.accentColor);
    this.textures.floorMap.repeat.set(24, 24);
    this.textures.floorBump.repeat.set(24, 24);

    // 1. Lighting Rig (Warm Key + Cool Hemisphere + 2 Rim PointLights)
    const hemi = new THREE.HemisphereLight(0x7dd3fc, 0x0f172a, 0.96);
    this.arenaGroup.add(hemi);

    const keyLight = new THREE.DirectionalLight(map.keyLightColor, 2.0);
    keyLight.position.set(36, 56, 32);
    if (!this.isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 4;
      keyLight.shadow.camera.far = 155;
      keyLight.shadow.camera.left = -62;
      keyLight.shadow.camera.right = 62;
      keyLight.shadow.camera.top = 62;
      keyLight.shadow.camera.bottom = -62;
      keyLight.shadow.bias = -0.0005;
    }
    this.arenaGroup.add(keyLight);

    const cobaltBaseLight = new THREE.PointLight(0x06b6d4, 28, 52, 1.4);
    cobaltBaseLight.position.set(-42, 6.2, 0);
    this.arenaGroup.add(cobaltBaseLight);

    const amberBaseLight = new THREE.PointLight(0xf59e0b, 28, 52, 1.4);
    amberBaseLight.position.set(42, 6.2, 0);
    this.arenaGroup.add(amberBaseLight);

    // 2. Arena Floor
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.textures.floorMap,
      bumpMap: this.textures.floorBump,
      bumpScale: 0.04,
      roughness: 0.54,
      metalness: 0.36,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.halfSize * 2, map.halfSize * 2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.arenaGroup.add(floor);

    // Team Zone Floor Decals (+0.02 Y offset)
    const cobaltPad = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4.1, 32),
      new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    cobaltPad.rotation.x = -Math.PI / 2;
    cobaltPad.position.set(-42, 0.02, 0);
    this.arenaGroup.add(cobaltPad);

    const amberPad = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4.1, 32),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    amberPad.rotation.x = -Math.PI / 2;
    amberPad.position.set(42, 0.02, 0);
    this.arenaGroup.add(amberPad);

    // 3. Perimeter Arena Walls
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.textures.wallMap,
      bumpMap: this.textures.wallBump,
      bumpScale: 0.038,
      roughness: 0.54,
      metalness: 0.48,
    });
    const hs = map.halfSize;
    const perimeterSpecs: Array<[number, number, number, number, number, number]> = [
      [0, 4.5, -hs, hs * 2, 9.0, 1.4],
      [0, 4.5, hs, hs * 2, 9.0, 1.4],
      [-hs, 4.5, 0, 1.4, 9.0, hs * 2],
      [hs, 4.5, 0, 1.4, 9.0, hs * 2],
    ];
    for (const [px, py, pz, pw, ph, pd] of perimeterSpecs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), wallMat);
      m.position.set(px, py, pz);
      m.receiveShadow = true;
      this.arenaGroup.add(m);
    }

    // Team Territory Wall Conduit Ribbons (West=Cobalt, East=Amber)
    const cobaltWallGlow = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const amberWallGlow = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    const westBanner = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.48, 36), cobaltWallGlow);
    westBanner.position.set(-hs + 0.78, 4.5, 0);
    this.arenaGroup.add(westBanner);
    const eastBanner = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.48, 36), amberWallGlow);
    eastBanner.position.set(hs - 0.78, 4.5, 0);
    this.arenaGroup.add(eastBanner);

    // Overhead Industrial Gantry Trusses
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.48, metalness: 0.76 });
    const lightStripMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(map.accentColor) });
    for (const tz of [-40, -20, 0, 20, 40]) {
      const truss = new THREE.Mesh(new THREE.BoxGeometry(hs * 2, 0.48, 0.9), beamMat);
      truss.position.set(0, 12.6, tz);
      this.arenaGroup.add(truss);

      const upperChord = new THREE.Mesh(new THREE.BoxGeometry(hs * 2, 0.28, 0.55), beamMat);
      upperChord.position.set(0, 13.7, tz);
      this.arenaGroup.add(upperChord);

      for (const gx of [-40, -20, 0, 20, 40]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.1, 0.46), beamMat);
        strut.position.set(gx, 13.15, tz);
        this.arenaGroup.add(strut);
      }

      const strip = new THREE.Mesh(new THREE.BoxGeometry(hs * 1.45, 0.09, 0.2), lightStripMat);
      strip.position.set(0, 12.28, tz);
      this.arenaGroup.add(strip);
    }

    // 4. Static Architectural Colliders
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.38, metalness: 0.82 });
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x293548, roughness: 0.44, metalness: 0.68 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.3, metalness: 0.85 });

    for (const col of map.colliders) {
      const grp = new THREE.Group();

      if (col.materialTag === 'ramp') {
        const ascDir = col.x < 0 ? 1 : -1;
        const lowH = Math.max(0.04, col.h - 0.65);
        const highH = col.h;
        const halfW = col.w * 0.5;
        const wedgeShape = new THREE.Shape();
        if (ascDir > 0) {
          wedgeShape.moveTo(-halfW, 0);
          wedgeShape.lineTo(halfW, 0);
          wedgeShape.lineTo(halfW, highH);
          wedgeShape.lineTo(-halfW, lowH);
        } else {
          wedgeShape.moveTo(-halfW, 0);
          wedgeShape.lineTo(halfW, 0);
          wedgeShape.lineTo(halfW, lowH);
          wedgeShape.lineTo(-halfW, highH);
        }
        wedgeShape.closePath();

        const wedgeGeo = new THREE.ExtrudeGeometry(wedgeShape, {
          steps: 1,
          depth: col.d,
          bevelEnabled: false,
        });
        wedgeGeo.translate(0, 0, -col.d * 0.5);
        const wedge = new THREE.Mesh(wedgeGeo, rampMat);
        wedge.position.set(col.x, 0, col.z);
        wedge.castShadow = true;
        wedge.receiveShadow = true;
        grp.add(wedge);

        const slopeLen = Math.hypot(col.w, highH - lowH);
        const slopeAngle = Math.atan2(highH - lowH, col.w) * ascDir;
        for (const rz of [-col.d * 0.48, col.d * 0.48]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 0.08, 0.1), lightStripMat);
          rail.position.set(col.x, (lowH + highH) * 0.5 + 0.04, col.z + rz);
          rail.rotation.z = slopeAngle;
          grp.add(rail);
        }
      } else {
        grp.position.set(col.x, col.y, col.z);
        const body = new THREE.Mesh(new THREE.BoxGeometry(col.w, col.h, col.d), wallMat);
        body.castShadow = true;
        body.receiveShadow = true;
        grp.add(body);

        const plinth = new THREE.Mesh(new THREE.BoxGeometry(col.w + 0.24, 0.24, col.d + 0.24), trimMat);
        plinth.position.y = -col.h * 0.5 + 0.12;
        grp.add(plinth);

        const cap = new THREE.Mesh(new THREE.BoxGeometry(col.w + 0.18, 0.16, col.d + 0.18), trimMat);
        cap.position.y = col.h * 0.5 - 0.04;
        grp.add(cap);

        if (col.materialTag === 'pillar') {
          for (const cx of [-col.w * 0.48, col.w * 0.48]) {
            for (const cz of [-col.d * 0.48, col.d * 0.48]) {
              const rib = new THREE.Mesh(new THREE.BoxGeometry(0.24, col.h - 0.2, 0.24), trimMat);
              rib.position.set(cx, 0, cz);
              grp.add(rib);
            }
          }
          const collar = new THREE.Mesh(new THREE.BoxGeometry(col.w + 0.2, 0.1, col.d + 0.2), lightStripMat);
          collar.position.y = col.h * 0.5 - 0.45;
          grp.add(collar);
        } else if (col.materialTag === 'platform' && col.h >= 2.0) {
          const faceSign = col.z < 0 ? 1 : -1;
          const railZ = faceSign * (col.d * 0.5 - 0.12);
          const topBar = new THREE.Mesh(new THREE.BoxGeometry(col.w - 0.2, 0.08, 0.08), railMat);
          topBar.position.set(0, col.h * 0.5 + 0.85, railZ);
          grp.add(topBar);
          const midBar = new THREE.Mesh(new THREE.BoxGeometry(col.w - 0.2, 0.05, 0.06), lightStripMat);
          midBar.position.set(0, col.h * 0.5 + 0.45, railZ);
          grp.add(midBar);
          for (let px = -col.w * 0.45; px <= col.w * 0.45 + 0.01; px += col.w * 0.225) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), trimMat);
            post.position.set(px, col.h * 0.5 + 0.45, railZ);
            grp.add(post);
          }
        }
      }

      this.arenaGroup.add(grp);
    }

    // 5. Central Monument Landmark
    const landmark = buildCentralLandmark(map.accentColor);
    landmark.group.position.set(map.controlCore.x, 0, map.controlCore.z);
    landmark.group.scale.setScalar(1.32);
    this.centralSpinner = landmark.spinner;
    this.centralInnerSpinner = landmark.innerSpinner;
    this.arenaGroup.add(landmark.group);

    // 6. Destructible Energy Barriers
    for (const b of map.barriers) {
      const vis = buildDestructibleBarrier(b.w, b.h, b.d, this.textures.barrierMap);
      vis.group.position.set(b.x, b.y, b.z);
      this.arenaGroup.add(vis.group);
      this.barrierVisuals.set(b.id, vis);
    }

    // 7. Environmental Hazards
    for (const h of map.hazards) {
      const vis = buildHazardAssembly(h);
      this.arenaGroup.add(vis.group);
      this.hazardVisuals.set(h.id, vis);
    }

    // 8. Mineral Ore Vein Crystal Nodes
    for (const o of map.oreNodes) {
      const vis = buildOreNodeAssembly(o);
      this.arenaGroup.add(vis.group);
      this.oreVisuals.set(o.id, vis);
    }

    // 9. Simplified Proxy Collision Boxes attached for all Arena Models (walls, perimeter, landmark, ore nodes, hazards, barriers)
    const colliderProxyGroup = new THREE.Group();
    colliderProxyGroup.name = 'arena_collider_boxes';
    const proxyBoxGeo = new THREE.BoxGeometry(1, 1, 1);
    const proxyBoxMat = new THREE.MeshBasicMaterial({ visible: false });
    const propColliders = buildMapPropColliders(map);
    this.cachedPropCollidersMapId = map.id;
    this.cachedPropColliders = propColliders;
    const allStaticAndPropColliders = [...map.colliders, ...propColliders];
    for (const col of allStaticAndPropColliders) {
      const boxMesh = new THREE.Mesh(proxyBoxGeo, proxyBoxMat);
      boxMesh.name = `collider_${col.id}`;
      boxMesh.position.set(col.x, col.y, col.z);
      boxMesh.scale.set(col.w, col.h, col.d);
      boxMesh.userData = { isColliderBox: true, colliderId: col.id, materialTag: col.materialTag || 'wall' };
      colliderProxyGroup.add(boxMesh);
    }
    for (const b of map.barriers) {
      const vis = this.barrierVisuals.get(b.id);
      if (vis) {
        const barBox = new THREE.Mesh(proxyBoxGeo, proxyBoxMat);
        barBox.name = `collider_${b.id}`;
        barBox.scale.set(b.w, b.h, b.d);
        barBox.userData = { isColliderBox: true, colliderId: b.id, materialTag: 'barrier' };
        vis.group.add(barBox);
      }
    }
    this.arenaGroup.add(colliderProxyGroup);

    // Rebuild local RoboMaster rig with fresh contactShadowMap
    this.ensureLocalRobotRig();
  }

  private spawnParticles(pos: Vec3, hex: string, count: number, speed: number): void {
    const col = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const p = this.particles[this.particleCursor];
      this.particleCursor = (this.particleCursor + 1) % this.particles.length;
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      p.z = pos.z;
      p.vx = (Math.random() - 0.5) * speed * 2;
      p.vy = Math.random() * speed * 1.1;
      p.vz = (Math.random() - 0.5) * speed * 2;
      p.maxLife = 0.25 + Math.random() * 0.28;
      p.life = p.maxLife;
      p.scale = 0.7 + Math.random() * 0.8;
      p.color.copy(col);
      this.particleMesh.setColorAt(this.particleCursor, p.color);
    }
    if (this.particleMesh.instanceColor) {
      this.particleMesh.instanceColor.needsUpdate = true;
    }
  }

  private tryFireWeapon(): void {
    if (this.phase !== 'playing' || this.overheated) return;
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    if (me && !me.alive) return;

    const now = performance.now();
    const activeClass = this.getEffectiveLocalRobotClass(me);
    if (!canRobotClassFire(activeClass)) {
      if (now - this.lastNoAmmoCueMs > 1400) {
        this.lastNoAmmoCueMs = now;
        this.setEconomyAlert(this.nearbyOreNode ? 'ep_unarmed_mine' : 'ep_unarmed_harvest');
      }
      return;
    }

    if (me && me.ammo <= 0) {
      if (now - this.lastNoAmmoCueMs > 900) {
        this.lastNoAmmoCueMs = now;
        this.setEconomyAlert('no_ammo');
        soundEngine.playHazardTelegraph();
      }
      return;
    }

    const weapon = WEAPONS[me?.weaponId ?? this.loadout.weaponId] || WEAPONS.pulse_carbine;
    const overclockMult = this.isLocalOverclocked(me) ? 0.65 : 1.0;
    if (now - this.lastShotMs < weapon.fireIntervalMs * overclockMult) return;
    if (!this.sendAction('player:fire', { yaw: this.yaw, pitch: this.pitch, ads: this.adsActive || this.gamepadAds })) return;
    this.lastShotMs = now;

    this.heat = Math.min(100, this.heat + weapon.heatPerShot);
    if (this.heat >= 100) {
      this.overheated = true;
    }

    this.trauma = Math.min(1, this.trauma + (weapon.id === 'prism_railgun' ? 0.2 : 0.07));
    soundEngine.playLaserFire(weapon.id);
    this.triggerHaptic(weapon.id === 'prism_railgun' ? 0.4 : 0.18, 0.12, 55);
  }

  private triggerDash(): void {
    if (this.dashCooldown > 0 || this.wantsDash || this.phase !== 'playing') return;
    this.wantsDash = true;
    soundEngine.playDash();
  }

  private triggerGadget(): void {
    if (this.gadgetCooldown > 0 || this.phase !== 'playing') return;
    const spec = GADGETS[this.loadout.gadgetId] || GADGETS.phase_dash;
    if (!this.sendAction('player:gadget')) return;
    this.gadgetCooldown = spec.cooldownSec;
    if (spec.id === 'phase_dash') {
      soundEngine.playDash();
    } else {
      soundEngine.playHazardTelegraph();
    }
  }

  private triggerClassSkill(): void {
    if (this.classSkillCooldown > 0 || this.phase !== 'playing') return;
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    const spec = ROBOT_CLASSES[this.getEffectiveLocalRobotClass(me)];
    if (!this.sendAction('player:class_skill')) return;
    this.classSkillCooldown = spec.classSkillCooldownSec;
    this.localOverclockUntil = performance.now() + 5000;
    if (spec.id === 's1_striker') {
      this.heat = 0;
      this.overheated = false;
    }
    this.setEconomyAlert(spec.id === 'ep_miner' ? 'turbo_extraction' : 'overclock_surge');
    soundEngine.playDash();
  }

  private isLocalOverclocked(me: CombatantSnapshot | undefined): boolean {
    return Boolean(me?.overclocked) || performance.now() < this.localOverclockUntil;
  }

  private updateNearbyOreNode(): NearbyOreHudInfo | null {
    if (!this.latestSnapshot) return null;
    const map = MAPS[this.currentMapId];
    let closest: NearbyOreHudInfo | null = null;
    for (const def of map.oreNodes) {
      const rt = this.latestSnapshot.oreNodes.find((n) => n.id === def.id);
      if (!rt || rt.depleted || rt.amount <= 0) continue;
      const dist = Math.hypot(def.x - this.playerPos.x, def.z - this.playerPos.z);
      if (dist <= ORE_MINE_RADIUS + 1.1 && (!closest || dist < closest.dist)) {
        closest = {
          id: def.id,
          label: def.label,
          amount: Math.round(rt.amount),
          maxAmount: rt.maxAmount,
          tier: def.tier,
          dist: Number(dist.toFixed(1)),
        };
      }
    }
    return closest;
  }

  private stepGameplay(dt: number): void {
    const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
    const alive = Boolean(me?.alive && this.latestSnapshot?.phase === 'active');

    // Weapon heat & cooldowns
    const weapon = WEAPONS[me?.weaponId ?? this.loadout.weaponId];
    const coolMult = this.overheated ? 1.45 : 1.0;
    this.heat = Math.max(0, this.heat - weapon.coolRatePerSec * coolMult * dt);
    if (this.overheated && this.heat <= 15) {
      this.overheated = false;
    }

    if (this.gadgetCooldown > 0) this.gadgetCooldown = Math.max(0, this.gadgetCooldown - dt);
    if (this.classSkillCooldown > 0) this.classSkillCooldown = Math.max(0, this.classSkillCooldown - dt);
    if (this.hitmarkerTimer > 0) this.hitmarkerTimer = Math.max(0, this.hitmarkerTimer - dt);
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);

    // Gamepad polling
    let gpMoveX = 0;
    let gpMoveZ = 0;
    let gpFire = false;
    this.gamepadAds = false;
    const gp = this.controller.gamepadEnabled && navigator.getGamepads
      ? navigator.getGamepads().find((p) => p && p.connected)
      : null;
    if (gp) {
      this.gamepadName = gp.id.slice(0, 28);
      const pingHeld = gp.mapping === 'standard' && !!gp.buttons[13]?.pressed;
      const padWasSelecting = this.tacticalMenu?.source === 'gamepad';
      if (pingHeld && !this.gamepadPingHeld) this.openTacticalMenu('gamepad');
      if (!pingHeld && padWasSelecting) this.closeTacticalMenu(true);
      this.gamepadPingHeld = pingHeld;

      const ldz = this.controller.leftStickDeadzone;
      const rdz = this.controller.rightStickDeadzone;
      const rx = gp.axes[2] || 0;
      const ry = gp.axes[3] || 0;
      if (this.tacticalMenu?.source === 'gamepad' && Math.hypot(rx, ry) > Math.max(0.4, rdz)) {
        this.selectTacticalKind(tacticalDirection(rx, ry));
      } else if (!this.tacticalMenu && !padWasSelecting) {
        gpMoveX = Math.abs(gp.axes[0] || 0) > ldz ? gp.axes[0] : 0;
        gpMoveZ = Math.abs(gp.axes[1] || 0) > ldz ? gp.axes[1] : 0;
        this.targetYaw -= (Math.abs(rx) > rdz ? rx : 0) * this.controller.gamepadSensitivity * dt;
        const ySign = this.controller.invertY ? 1 : -1;
        this.targetPitch = THREE.MathUtils.clamp(
          this.targetPitch + (Math.abs(ry) > rdz ? ry : 0) * ySign * this.controller.gamepadSensitivity * 0.75 * dt,
          -0.95,
          0.95,
        );

        gpFire = (gp.buttons[7]?.value ?? 0) > this.controller.triggerThreshold;
        this.gamepadAds = (gp.buttons[6]?.value ?? 0) > this.controller.triggerThreshold;
        if (gp.buttons[1]?.pressed) this.triggerDash();
        if (gp.buttons[3]?.pressed) this.triggerClassSkill();
        if (gp.buttons[5]?.pressed) this.triggerGadget();
      }
    } else {
      this.gamepadName = null;
      this.gamepadPingHeld = false;
      if (this.tacticalMenu?.source === 'gamepad') this.closeTacticalMenu();
    }

    if (!alive) {
      this.closeTacticalMenu();
      this.localMiningActive = false;
      this.nearbyOreNode = null;
      return;
    }

    // Keyboard turn fallback
    if (!this.tacticalMenu) {
      if (this.keys.has('ArrowLeft')) this.targetYaw += 2.1 * dt;
      if (this.keys.has('ArrowRight')) this.targetYaw -= 2.1 * dt;
    }

    // Movement vector
    let forwardInput =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    let strafeInput = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    forwardInput -= gpMoveZ;
    strafeInput += gpMoveX;

    const inputLen = Math.hypot(forwardInput, strafeInput);
    if (inputLen > 1) {
      forwardInput /= inputLen;
      strafeInput /= inputLen;
    }

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const wishX = -sinY * forwardInput + cosY * strafeInput;
    const wishZ = -cosY * forwardInput - sinY * strafeInput;

    const map = MAPS[this.currentMapId];
    this.inputClock += dt;
    if (this.inputClock >= MOVEMENT_STEP_SEC) {
      this.inputClock -= MOVEMENT_STEP_SEC;
      this.sendMovementInput(wishX, wishZ);
    }

    const oldX = this.playerPos.x;
    const oldZ = this.playerPos.z;
    if (this.predictedMotion) {
      const { pos, chassisYaw } = this.predictedMotion;
      _vec3A.set(pos.x, pos.y, pos.z);
      // A spawn/large correction snaps immediately; small corrections are blended across render frames.
      if (this.playerPos.distanceToSquared(_vec3A) > 9) this.playerPos.copy(_vec3A);
      else this.playerPos.lerp(_vec3A, 1 - Math.exp(-32 * dt));
      this.localChassisYaw = normalizeAngle(this.localChassisYaw +
        normalizeAngle(chassisYaw - this.localChassisYaw) * (1 - Math.exp(-28 * dt)));
    }
    const movedHoriz = Math.hypot(this.playerPos.x - oldX, this.playerPos.z - oldZ);
    const now = performance.now();
    const wantsFire =
      this.mouseDown || gpFire || this.keys.has('KeyF') || this.isBindingKeyHeld(this.controller.bindings.fire);

    // Detect nearby ore vein & handle hold-to-mine ([E] or EP Miner LMB near ore)
    this.nearbyOreNode = this.updateNearbyOreNode();
    const holdingMineKey = this.isBindingKeyHeld(this.controller.bindings.classSkill) || this.keys.has('KeyE');
    const epAutoMineWithFire =
      !canRobotClassFire(this.getEffectiveLocalRobotClass(me)) &&
      Boolean(this.nearbyOreNode) &&
      (this.mouseDown || gpFire);

    if (this.nearbyOreNode && (holdingMineKey || epAutoMineWithFire)) {
      this.localMiningActive = true;
      if (now - this.lastMineSentMs >= 150) {
        this.lastMineSentMs = now;
        this.sendAction('player:mine');
      }
      if (now - this.lastMineSparkMs >= 180) {
        this.lastMineSparkMs = now;
        const oreDef = map.oreNodes.find((n) => n.id === this.nearbyOreNode!.id);
        if (oreDef) {
          this.spawnParticles(
            { x: oreDef.x, y: 1.0, z: oreDef.z },
            oreDef.tier === 'rich' ? '#FBBF24' : '#34D399',
            3,
            3.2,
          );
        }
      }
    } else {
      this.localMiningActive = false;
      if (wantsFire) {
        this.tryFireWeapon();
      }
    }

    // Animate local player's RoboMaster robot rig
    if (this.localRobotRig) {
      this.localRobotRig.root.visible = true;
      this.localRobotRig.root.position.copy(this.playerPos);
      this.localRobotRig.root.rotation.y = this.localChassisYaw;
      const turretRelYaw = normalizeAngle(this.yaw - this.localChassisYaw);
      this.localRobotRig.animate(
        movedHoriz,
        dt,
        this.pitch,
        turretRelYaw,
        this.localMiningActive,
        this.isLocalOverclocked(me),
      );
    }
  }

  private updateMiningTethers(now: number, dt: number): void {
    const map = MAPS[this.currentMapId];
    let beamIdx = 0;

    // 1. Local player mining tether
    if (this.phase === 'playing' && this.localMiningActive && this.nearbyOreNode && this.localRobotRig) {
      const oreDef = map.oreNodes.find((n) => n.id === this.nearbyOreNode!.id);
      if (oreDef && beamIdx < this.miningBeamPool.length) {
        this.localRobotRig.root.updateMatrixWorld(true);
        this.localRobotRig.getMiningEmitterWorldPos(_vec3A);
        _vec3B.set(oreDef.x, 1.05, oreDef.z);
        const slot = this.miningBeamPool[beamIdx++];
        const dist = Math.max(0.2, _vec3A.distanceTo(_vec3B));
        slot.mesh.position.copy(_vec3A).lerp(_vec3B, 0.5);
        slot.mesh.lookAt(_vec3B);
        slot.mesh.scale.set(1, 1, dist);
        slot.mat.color.setHex(oreDef.tier === 'rich' ? 0xfbbf24 : 0x34d399);
        slot.mat.opacity = 0.65 + Math.sin(now * 0.018) * 0.25;
        slot.mesh.visible = true;
      }
    }

    // 2. Remote robot mining tethers
    for (const actor of this.remoteActors.values()) {
      if (!actor.rig.root.visible || !actor.miningNodeId) continue;
      if (beamIdx >= this.miningBeamPool.length) break;
      const oreDef = map.oreNodes.find((n) => n.id === actor.miningNodeId);
      if (!oreDef) continue;

      actor.rig.root.updateMatrixWorld(true);
      actor.rig.getMiningEmitterWorldPos(_vec3A);
      _vec3B.set(oreDef.x, 1.05, oreDef.z);
      const slot = this.miningBeamPool[beamIdx++];
      const dist = Math.max(0.2, _vec3A.distanceTo(_vec3B));
      slot.mesh.position.copy(_vec3A).lerp(_vec3B, 0.5);
      slot.mesh.lookAt(_vec3B);
      slot.mesh.scale.set(1, 1, dist);
      slot.mat.color.setHex(oreDef.tier === 'rich' ? 0xfbbf24 : 0x34d399);
      slot.mat.opacity = 0.6 + Math.sin(now * 0.018 + beamIdx) * 0.25;
      slot.mesh.visible = true;

      if (Math.random() < dt * 7) {
        this.spawnParticles({ x: oreDef.x, y: 1.0, z: oreDef.z }, '#34D399', 1, 2.4);
      }
    }

    // Hide remaining pooled beams
    for (let i = beamIdx; i < this.miningBeamPool.length; i++) {
      this.miningBeamPool[i].mesh.visible = false;
    }
  }

  private tick = (): void => {
    if (this.disposed) return;

    try {
      const now = performance.now();
      const rawDt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;
      const dt = Number.isFinite(rawDt) ? Math.min(Math.max(rawDt, 0.001), 0.05) : 0.016;

      if (!Number.isFinite(this.playerPos.x) || !Number.isFinite(this.playerPos.y) || !Number.isFinite(this.playerPos.z)) {
        this.syncSpawnFromSnapshot();
      }
      if (!Number.isFinite(this.yaw)) this.yaw = -Math.PI / 2;
      if (!Number.isFinite(this.targetYaw)) this.targetYaw = this.yaw;
      if (!Number.isFinite(this.pitch)) this.pitch = -0.04;
      if (!Number.isFinite(this.targetPitch)) this.targetPitch = this.pitch;

      // Apply accumulated pointer deltas smoothly every frame (prevents mouse-polling beat stutter)
      if (this.phase === 'playing' && !this.tacticalMenu) {
        if (this.pendingLookDx !== 0 || this.pendingLookDy !== 0) {
          const sens =
            0.0022 *
            this.controller.mouseSensitivity *
            (this.adsActive || this.gamepadAds ? this.controller.adsMultiplier : 1.0);
          const ySign = this.controller.invertY ? 1 : -1;
          this.targetYaw = normalizeAngle(this.targetYaw - this.pendingLookDx * sens);
          this.targetPitch = THREE.MathUtils.clamp(
            this.targetPitch + this.pendingLookDy * sens * ySign,
            -0.95,
            0.95,
          );
          this.pendingLookDx = 0;
          this.pendingLookDy = 0;
        }
      } else {
        this.pendingLookDx = 0;
        this.pendingLookDy = 0;
      }

      if (this.hitstopTimer > 0) {
        this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      } else if (this.phase === 'playing') {
        this.stepGameplay(dt);
      }

      if (this.phase === 'playing') {
        if (this.isSoftwareGl) {
          this.yaw = normalizeAngle(this.targetYaw);
          this.pitch = this.targetPitch;
        } else {
          const lookAlpha = 1 - Math.exp(-56 * dt);
          const yawDiff = normalizeAngle(this.targetYaw - this.yaw);
          this.yaw = normalizeAngle(this.yaw + yawDiff * lookAlpha);
          this.pitch = THREE.MathUtils.clamp(
            this.pitch + (this.targetPitch - this.pitch) * lookAlpha,
            -0.95,
            0.95,
          );
        }
      }

    // Animate Central Landmark & Ore Vein Crystals
    if (this.centralSpinner) {
      this.centralSpinner.rotation.y += dt * 0.65;
      this.centralSpinner.rotation.x = Math.sin(now * 0.0012) * 0.18;
    }
    if (this.centralInnerSpinner) {
      this.centralInnerSpinner.rotation.z -= dt * 1.15;
      this.centralInnerSpinner.rotation.y -= dt * 0.85;
    }
    for (const vis of this.oreVisuals.values()) {
      vis.haloMesh.rotation.z += dt * 1.35;
      vis.crystalGroup.rotation.y += dt * 0.35;
    }

    // Interpolate from the last rendered pose rather than predicting other players' inputs.
    for (const actor of this.remoteActors.values()) {
      if (!actor.rig.root.visible) continue;
      const prevX = actor.rig.root.position.x;
      const prevZ = actor.rig.root.position.z;
      const fraction = THREE.MathUtils.clamp((now - actor.lastSnapshotMs) / (MOVEMENT_STEP_SEC * 1000), 0, 1);
      actor.rig.root.position.lerpVectors(actor.previousPos, actor.targetPos, fraction);
      actor.chassisYaw = normalizeAngle(actor.previousChassisYaw +
        normalizeAngle(actor.targetChassisYaw - actor.previousChassisYaw) * fraction);
      actor.aimYaw = normalizeAngle(actor.previousAimYaw +
        normalizeAngle(actor.targetAimYaw - actor.previousAimYaw) * fraction);
      actor.aimPitch = THREE.MathUtils.lerp(actor.previousPitch, actor.targetPitch, fraction);

      actor.rig.root.rotation.y = actor.chassisYaw;
      const turretRelYaw = normalizeAngle(actor.aimYaw - actor.chassisYaw);
      const stepDist = Math.hypot(actor.rig.root.position.x - prevX, actor.rig.root.position.z - prevZ);
      actor.rig.animate(
        stepDist,
        dt,
        actor.aimPitch,
        turretRelYaw,
        actor.isMining,
        actor.isOverclocked,
      );
    }

    this.updateMiningTethers(now, dt);

    // Update Pooled Particles (Zero-GC)
    let particlesDirty = false;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      particlesDirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        _mat4.makeScale(0, 0, 0);
        this.particleMesh.setMatrixAt(i, _mat4);
      } else {
        p.vy -= 14 * dt;
        p.x += p.vx * dt;
        p.y = Math.max(0.05, p.y + p.vy * dt);
        p.z += p.vz * dt;
        const s = p.scale * (p.life / p.maxLife);
        _vec3C.set(p.x, p.y, p.z);
        _quat.identity();
        _vec3B.set(s, s, s);
        _mat4.compose(_vec3C, _quat, _vec3B);
        this.particleMesh.setMatrixAt(i, _mat4);
      }
    }
    if (particlesDirty) {
      this.particleMesh.instanceMatrix.needsUpdate = true;
    }

    // Update Pooled Beams
    for (const b of this.beamPool) {
      if (!b.mesh.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.visible = false;
      } else {
        b.mat.opacity = b.life / b.maxLife;
      }
    }

    // Camera Choreography
    this.trauma = Math.max(0, this.trauma - dt * 2.4);
    const shake = this.trauma * this.trauma;

    if (this.phase === 'title') {
      if (this.localRobotRig) this.localRobotRig.root.visible = false;
      this.titleOrbitAngle += dt * 0.14;
      const r = 32;
      this.camera.position.set(
        Math.cos(this.titleOrbitAngle) * r,
        12.5 + Math.sin(this.titleOrbitAngle * 0.7) * 2.0,
        Math.sin(this.titleOrbitAngle) * r,
      );
      this.camera.lookAt(0, 3.6, 0);
    } else {
      const { position } = computePlayerCamera(this.playerPos,
        { yaw: this.yaw, pitch: this.pitch, ads: this.adsActive || this.gamepadAds },
        this.getActiveCollidersCached(), MAPS[this.currentMapId].halfSize);
      this.camera.position.set(position.x, position.y, position.z);
      this.camera.rotation.set(
        this.pitch + (Math.random() - 0.5) * shake * 0.04,
        this.yaw + (Math.random() - 0.5) * shake * 0.04,
        (Math.random() - 0.5) * shake * 0.025,
        'YXZ',
      );

      // Smooth FOV kick on ADS & Dash
      const targetFov = this.adsActive || this.gamepadAds
        ? this.controller.fov * 0.78
        : this.dashTimer > 0
          ? this.controller.fov + 8
          : this.controller.fov;
      if (Math.abs(this.camera.fov - targetFov) > 0.1) {
        this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 14, dt);
        this.camera.updateProjectionMatrix();
      }
    }

      if (this.tacticalPings.size) {
        const nowWall = Date.now();
        for (const [id, { ping, marker }] of this.tacticalPings) {
          if (nowWall >= ping.expiresAt) this.removeTacticalPing(id);
          else marker.rotation.y += dt * 1.8;
        }
      }

      if (!this.contextLost) {
        if (this.needsShaderCompile && !this.isSoftwareGl && now - this.lastShaderCompileMs > 250) {
          this.needsShaderCompile = false;
          this.lastShaderCompileMs = now;
          this.renderer.compile(this.scene, this.camera);
        }

        this.renderer.render(this.scene, this.camera);
      }

      // Throttled HUD state emission (<= 10Hz)
      if (now - this.lastHudPush >= 95) {
        this.lastHudPush = now;
        this.emitHudState();
      }
    } catch (err) {
      console.error('Engine tick error:', err);
    } finally {
      this.scheduleNextFrame();
    }
  };

  private emitHudState(): void {
    const me: CombatantSnapshot | undefined = this.latestSnapshot?.players.find(
      (p) => p.id === this.localPlayerId,
    );
    const nowWall = Date.now();
    const nowPerf = performance.now();
    const map = MAPS[this.currentMapId];
    let hazardWarning: string | null = null;
    if (this.latestSnapshot) {
      for (let i = 0; i < map.hazards.length; i++) {
        const def = map.hazards[i];
        const rt = this.latestSnapshot.hazards[i];
        if (!rt || rt.phase === 'idle') continue;
        const dist = Math.hypot(this.playerPos.x - def.x, this.playerPos.z - def.z);
        if (dist <= def.radius + 3.5) {
          const phaseText =
            rt.phase === 'telegraph' ? UI_TEXT[this.lang].hazardCharging : UI_TEXT[this.lang].hazardActive;
          hazardWarning = `${translateHazardLabel(def.label, this.lang)} · ${phaseText}`;
          break;
        }
      }
    }

    const activeAlert =
      nowPerf < this.economyAlertUntil && this.economyAlertState
        ? formatEngineAlert(this.economyAlertState.key, this.lang, this.economyAlertState.packId)
        : null;
    const spec = GADGETS[this.loadout.gadgetId] || GADGETS.phase_dash;
    const activeRobotClass = this.getEffectiveLocalRobotClass(me);
    const classSpec = ROBOT_CLASSES[activeRobotClass] || ROBOT_CLASSES.s1_striker;
    const weaponSpec = WEAPONS[me?.weaponId ?? this.loadout.weaponId];
    const armed = canRobotClassFire(activeRobotClass);
    const serverClassMatches = !me || me.robotClass === activeRobotClass;
    const overclockRemaining = Math.max(0, (this.localOverclockUntil - nowPerf) / 1000);

    this.callbacks.onHudUpdate({
      hp: me ? Math.min(classSpec.maxHp, me.hp) : classSpec.maxHp,
      maxHp: serverClassMatches && me ? me.maxHp : classSpec.maxHp,
      shield: me ? Math.min(classSpec.maxShield, me.shield) : classSpec.maxShield,
      maxShield: serverClassMatches && me ? me.maxShield : classSpec.maxShield,
      ammo: armed ? (serverClassMatches && me ? me.ammo : weaponSpec.magSize) : 0,
      maxAmmo: armed ? (serverClassMatches && me ? me.maxAmmo : weaponSpec.magSize) : 0,
      robotClass: activeRobotClass,
      teamCredits: this.getLocalTeamCredits(me?.team),
      heat: armed ? Math.round(this.heat) : 0,
      overheated: armed ? this.overheated : false,
      gadgetCooldown: Number(this.gadgetCooldown.toFixed(1)),
      gadgetMaxCooldown: spec.cooldownSec,
      dashCooldown: Number(this.dashCooldown.toFixed(1)),
      classSkillCooldown: Number(this.classSkillCooldown.toFixed(1)),
      classSkillMaxCooldown: classSpec.classSkillCooldownSec,
      overclockActive: this.isLocalOverclocked(me),
      overclockRemainingSec: Number(overclockRemaining.toFixed(1)),
      isMining: this.localMiningActive,
      nearbyOreNode: this.nearbyOreNode,
      economyAlert: activeAlert,
      alive: me ? me.alive : true,
      respawnSec: me && !me.alive ? Math.max(0, Math.ceil((me.respawnAt - nowWall) / 1000)) : 0,
      slowed: me ? me.slowedUntil > nowWall : false,
      shielded: me ? me.shieldActive : false,
      hitmarkerActive: this.hitmarkerTimer > 0,
      hitmarkerKilled: this.hitmarkerKilled,
      damageFlash: this.damageFlash,
      hazardWarning,
      pointerLocked: this.pointerLocked,
      gamepadName: this.gamepadName,
      playerPos: { x: this.playerPos.x, y: this.playerPos.y, z: this.playerPos.z },
      playerYaw: this.yaw,
      tacticalMenu: this.tacticalMenu?.kind,
      tacticalPings: Array.from(this.tacticalPings.values(), ({ ping }) => ping),
    });
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const poll = () => {
      if (this.disposed) {
        gl.deleteSync(sync);
        return;
      }
      const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private triggerHaptic(weakMagnitude: number, strongMagnitude: number, duration: number): void {
    if (!this.controller.vibrationEnabled || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const gp = pads.find((p) => p && p.connected) as
      | (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } })
      | undefined;
    gp?.vibrationActuator?.playEffect?.('dual-rumble', {
      startDelay: 0,
      duration,
      weakMagnitude,
      strongMagnitude,
    }).catch(() => {});
  }

  private extractKeyboardToken(bindingSpec: string | undefined): string {
    if (typeof bindingSpec !== 'string') return '';
    return (bindingSpec.split('/')[0] || '').trim().toLowerCase();
  }

  private matchesBinding(e: KeyboardEvent, bindingSpec: string | undefined, fallbackCodes: string[]): boolean {
    const token = this.extractKeyboardToken(bindingSpec);
    if (!token || token.startsWith('mouse')) {
      return fallbackCodes.includes(e.code);
    }
    const codeLower = e.code.toLowerCase();
    const keyLower = e.key.toLowerCase();
    if (token === 'space') return e.code === 'Space';
    if (token === 'shift') return e.code === 'ShiftLeft' || e.code === 'ShiftRight';
    if (token === 'ctrl' || token === 'control') return e.code === 'ControlLeft' || e.code === 'ControlRight';
    if (token === 'alt') return e.code === 'AltLeft' || e.code === 'AltRight';
    return codeLower === token || codeLower === `key${token}` || keyLower === token;
  }

  private isBindingKeyHeld(bindingSpec: string | undefined): boolean {
    const token = this.extractKeyboardToken(bindingSpec);
    if (!token || token.startsWith('mouse')) return false;
    for (const code of this.keys) {
      const c = code.toLowerCase();
      if (c === token || c === `key${token}`) return true;
    }
    return false;
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================
  private onTacticalEscape = (e: KeyboardEvent) => {
    if (e.code !== 'Escape' || !this.tacticalMenu) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.closeTacticalMenu();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.phase !== 'playing' || isEditable(e.target)) return;
    if (e.code === 'KeyG' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey &&
        this.openTacticalMenu('keyboard')) {
      e.preventDefault();
      return;
    }
    if (this.tacticalMenu) {
      const kind = TACTICAL_KEYS[e.code];
      if (this.tacticalMenu.source === 'keyboard' && kind) {
        e.preventDefault();
        this.tacticalMenu.dx = this.tacticalMenu.dy = 0;
        this.selectTacticalKind(kind);
      }
      return;
    }

    const b = this.controller.bindings;
    if (!this.keys.has(e.code)) {
      if (e.code === 'Space') {
        e.preventDefault();
      } else if (this.matchesBinding(e, b.dash, ['ShiftLeft', 'ShiftRight'])) {
        this.triggerDash();
      } else if (this.matchesBinding(e, b.gadget, ['KeyQ'])) {
        this.triggerGadget();
      } else if (this.matchesBinding(e, b.classSkill, ['KeyE'])) {
        if (!this.nearbyOreNode || this.classSkillCooldown <= 0) {
          this.triggerClassSkill();
        }
      } else if (this.matchesBinding(e, b.buyAmmo, ['KeyB'])) {
        this.smartBuyAmmo();
      } else if (e.code === 'Digit1') {
        this.buyAmmoPack('light_mag');
      } else if (e.code === 'Digit2') {
        this.buyAmmoPack('full_mag');
      } else if (e.code === 'Digit3') {
        this.buyAmmoPack('combat_resupply');
      } else if (e.code === 'KeyU') {
        const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
        const currentClass = this.getEffectiveLocalRobotClass(me);
        const nextClass: RobotClass = currentClass === 'ep_miner' ? 's1_striker' : 'ep_miner';
        this.callbacks.onQuickSwitchClass?.(nextClass);
      } else if (this.matchesBinding(e, b.reload, ['KeyR'])) {
        const now = performance.now();
        if (now - this.lastVentMs >= VENT_COOLDOWN_MS && this.sendAction('player:vent')) {
          this.lastVentMs = now;
          this.heat = Math.max(0, this.heat - 45);
          this.overheated = false;
        }
      } else if (this.matchesBinding(e, b.voicePtt, ['KeyV'])) {
        this.callbacks.onVoicePttChange(true);
      }
    }
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'KeyG' && this.tacticalMenu?.source === 'keyboard') {
      e.preventDefault();
      this.closeTacticalMenu(true);
    }
    if (this.matchesBinding(e, this.controller.bindings.voicePtt, ['KeyV'])) {
      this.callbacks.onVoicePttChange(false);
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    if (this.phase !== 'playing' || this.tacticalMenu) return;
    if (e.target !== this.renderer.domElement) return;
    if (!this.pointerLocked) {
      this.requestPointerLock();
    }
    if (e.button === 0) {
      this.mouseDown = true;
      this.draggingLook = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      const me = this.latestSnapshot?.players.find((p) => p.id === this.localPlayerId);
      if (!(this.getEffectiveLocalRobotClass(me) === 'ep_miner' && this.nearbyOreNode)) {
        this.tryFireWeapon();
      }
    } else if (e.button === 2) {
      this.adsActive = true;
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.draggingLook = false;
    } else if (e.button === 2) {
      this.adsActive = false;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.phase !== 'playing') return;

    const menu = this.tacticalMenu;
    if (menu) {
      if (menu.source === 'keyboard') {
        const dx = e.movementX || (!this.pointerLocked && menu.cursor ? e.clientX - menu.cursor.x : 0);
        const dy = e.movementY || (!this.pointerLocked && menu.cursor ? e.clientY - menu.cursor.y : 0);
        menu.cursor = { x: e.clientX, y: e.clientY };
        if (Math.abs(dx) <= 220 && Math.abs(dy) <= 220) {
          menu.dx += dx;
          menu.dy += dy;
          const distance = Math.hypot(menu.dx, menu.dy);
          if (distance > 12) this.selectTacticalKind(tacticalDirection(menu.dx, menu.dy));
          if (distance > 36) {
            menu.dx *= 36 / distance;
            menu.dy *= 36 / distance;
          }
        }
      }
      return;
    }

    if (this.pointerLocked) {
      const mx = e.movementX;
      const my = e.movementY;
      // Filter Chromium pointer-lock wrap/boundary phantom jump spikes
      if (Math.abs(mx) <= 220 && Math.abs(my) <= 220) {
        this.pendingLookDx += mx;
        this.pendingLookDy += my;
      }
    } else if (this.draggingLook) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      if (Math.abs(dx) <= 240 && Math.abs(dy) <= 240) {
        this.pendingLookDx += dx * 1.4;
        this.pendingLookDy += dy * 1.4;
      }
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    if (this.phase === 'playing') e.preventDefault();
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) this.closeTacticalMenu();
    this.pendingLookDx = 0;
    this.pendingLookDy = 0;
  };

  private onTacticalFocus = (e: FocusEvent) => {
    if (isEditable(e.target)) this.closeTacticalMenu();
  };

  private onWindowBlur = () => {
    this.closeTacticalMenu();
    this.keys.clear();
    this.mouseDown = false;
    this.adsActive = false;
    this.gamepadAds = false;
    this.wantsDash = false;
    this.draggingLook = false;
    this.pendingLookDx = 0;
    this.pendingLookDy = 0;
    this.callbacks.onVoicePttChange(false);
  };

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private onWebGLContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onWebGLContextRestored = () => {
    this.contextLost = false;
  };

  private bindEvents(): void {
    window.addEventListener('keydown', this.onTacticalEscape, true);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('focusin', this.onTacticalFocus);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onWindowBlur);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onWebGLContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onWebGLContextRestored, false);
  }

  dispose(): void {
    this.disposed = true;
    this.tacticalMenu = null;
    this.clearTacticalPings();
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    window.removeEventListener('keydown', this.onTacticalEscape, true);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('focusin', this.onTacticalFocus);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onWindowBlur);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onWebGLContextLost, false);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onWebGLContextRestored, false);
    this.disposeObject3D(this.arenaGroup);
    if (this.localRobotRig) {
      this.disposeRobotRig(this.localRobotRig);
      this.localRobotRig = null;
    }
    for (const actor of this.remoteActors.values()) {
      this.disposeRobotRig(actor.rig);
    }
    this.remoteActors.clear();
    this.particleMesh.geometry.dispose();
    (this.particleMesh.material as THREE.Material).dispose();
    for (const b of this.beamPool) {
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.beamPool = [];
    for (const mb of this.miningBeamPool) {
      mb.mesh.geometry.dispose();
      mb.mat.dispose();
    }
    this.miningBeamPool = [];
    this.textures?.dispose();
    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
