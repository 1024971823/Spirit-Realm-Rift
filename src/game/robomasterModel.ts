import * as THREE from 'three';
import URDFLoader, { type URDFRobot } from 'urdf-loader';
import { ROBOT_HITBOX_SPECS } from '../shared/physics';
import type { RobotClass, TeamId } from '../shared/types';

export const ROBOMASTER_S1_URDF_URL = '/models/robomaster/robomaster_s1.urdf';
export const ROBOMASTER_EP_URDF_URL = '/models/robomaster/robomaster_ep.urdf';
export const ROBOMASTER_SCALE = 4.6;

const SHARED_COLLIDER_GEO = new THREE.BoxGeometry(1, 1, 1);
SHARED_COLLIDER_GEO.userData.sharedUrdfGeometry = true;
const SHARED_COLLIDER_MAT = new THREE.MeshBasicMaterial({ visible: false });
SHARED_COLLIDER_MAT.userData.sharedUrdfMaterial = true;

interface CachedTemplate {
  robot: URDFRobot;
  groundOffsetY: number;
}

export interface RoboMasterCombatantRig {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  colliderMeshes: THREE.Mesh[];
  shieldDome: THREE.Mesh;
  overclockRing: THREE.Mesh;
  robotClass: RobotClass;
  getMuzzleWorldPos: (out: THREE.Vector3) => THREE.Vector3;
  getMiningEmitterWorldPos: (out: THREE.Vector3) => THREE.Vector3;
  animate: (
    stepDist: number,
    dt: number,
    aimPitch: number,
    turretRelYaw: number,
    isMining: boolean,
    isOverclocked: boolean,
  ) => void;
}

const templatePromises = new Map<RobotClass, Promise<CachedTemplate>>();

function stripEmbeddedLightsAndCameras(root: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Light).isLight || (obj as THREE.Camera).isCamera) {
      toRemove.push(obj);
    }
  });
  for (const obj of toRemove) {
    obj.parent?.remove(obj);
  }
}

export function getRoboMasterTemplate(robotClass: RobotClass = 's1_striker'): Promise<CachedTemplate> {
  const existing = templatePromises.get(robotClass);
  if (existing) return existing;

  const urdfUrl = robotClass === 'ep_miner' ? ROBOMASTER_EP_URDF_URL : ROBOMASTER_S1_URDF_URL;

  const promise = new Promise<CachedTemplate>((resolve, reject) => {
    let loadedRobot: URDFRobot | null = null;
    let urdfParsed = false;
    let managerLoaded = false;
    let urdfFailed = false;
    let resolved = false;

    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.packages = {
      robomaster_description: '/models/robomaster',
    };

    const finalizeIfReady = () => {
      if (resolved || urdfFailed || !loadedRobot || !urdfParsed || !managerLoaded) return;
      resolved = true;
      stripEmbeddedLightsAndCameras(loadedRobot);

      loadedRobot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          const n = (obj.name || obj.parent?.name || '').toLowerCase();
          const isPrimarySilhouette =
            n.includes('chassis') ||
            n.includes('armor') ||
            n.includes('gimbal') ||
            n.includes('arm_1') ||
            n.includes('arm_2') ||
            n.includes('wheel');
          mesh.castShadow = isPrimarySilhouette;
          mesh.receiveShadow = false;
          if (mesh.geometry) {
            mesh.geometry.userData.sharedUrdfGeometry = true;
          }
        }
      });

      // Measure exact grounded offset in Three.js space (-Z forward, +Y up)
      const measureOuter = new THREE.Group();
      const measureInner = new THREE.Group();
      measureInner.rotation.x = -Math.PI / 2;
      measureOuter.rotation.y = Math.PI / 2;
      measureOuter.scale.setScalar(ROBOMASTER_SCALE);
      measureInner.add(loadedRobot);
      measureOuter.add(measureInner);
      measureOuter.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(measureOuter);
      const groundOffsetY = Number.isFinite(box.min.y) ? -box.min.y : 0.08;

      measureInner.remove(loadedRobot);
      resolve({ robot: loadedRobot, groundOffsetY });
    };

    manager.onLoad = () => {
      managerLoaded = true;
      finalizeIfReady();
    };

    manager.onError = (url) => {
      console.warn(`[RoboMaster ${robotClass} URDF] Asset load warning:`, url);
    };

    loader.load(
      urdfUrl,
      (robot) => {
        loadedRobot = robot;
        urdfParsed = true;
        finalizeIfReady();
      },
      undefined,
      (err) => {
        urdfFailed = true;
        templatePromises.delete(robotClass);
        reject(err);
      },
    );
  });

  templatePromises.set(robotClass, promise);
  return promise;
}

export function preloadAllRoboMasterTemplates(): void {
  getRoboMasterTemplate('s1_striker').catch(() => {});
  getRoboMasterTemplate('ep_miner').catch(() => {});
}

function tintClonedRobot(
  robot: URDFRobot,
  robotClass: RobotClass,
  teamColor: number,
  skinHex: string,
  beamHex: string,
): void {
  const clonedMaterials = new Map<THREE.Material, THREE.Material>();
  const skinColor = new THREE.Color(skinHex);
  const beamColor = new THREE.Color(beamHex);
  const engGold = new THREE.Color(0xfbbf24);

  const mapMaterial = (mat: THREE.Material, meshName: string): THREE.Material => {
    const existing = clonedMaterials.get(mat);
    if (existing) return existing;

    const matName = (mat.name || '').toLowerCase();
    const mName = meshName.toLowerCase();

    if (matName.includes('led') || mName.includes('led')) {
      const ledColor = robotClass === 'ep_miner' ? new THREE.Color(teamColor).lerp(engGold, 0.25) : new THREE.Color(teamColor);
      const ledMat = new THREE.MeshStandardMaterial({
        name: mat.name || 'team_led',
        color: ledColor,
        emissive: ledColor,
        emissiveIntensity: 2.35,
        roughness: 0.15,
        metalness: 0.15,
      });
      clonedMaterials.set(mat, ledMat);
      return ledMat;
    }

    const needsTint =
      matName.includes('armor') ||
      mName.includes('armor') ||
      matName.includes('gimbal_top') ||
      matName === 'plastic' ||
      matName.includes('cover_plastic') ||
      (robotClass === 'ep_miner' &&
        (matName.includes('ep_up') || mName.includes('gripper') || mName.includes('arm_')));

    if (!needsTint) {
      // Share untinted template materials (wheels, frames, screws, servos) to slash shader/uniform state changes
      mat.userData.sharedUrdfMaterial = true;
      clonedMaterials.set(mat, mat);
      return mat;
    }

    const cloned = mat.clone();
    if (cloned instanceof THREE.MeshStandardMaterial || cloned instanceof THREE.MeshPhongMaterial) {
      if (matName.includes('armor') || mName.includes('armor')) {
        cloned.color.copy(skinColor).lerp(new THREE.Color(0x1e293b), 0.22);
        if (cloned instanceof THREE.MeshStandardMaterial) {
          cloned.roughness = 0.38;
          cloned.metalness = 0.52;
        }
      } else if (matName.includes('gimbal_top') || matName === 'plastic') {
        cloned.color.lerp(beamColor, 0.24);
      } else if (matName.includes('ep_up') || mName.includes('gripper') || mName.includes('arm_')) {
        if (robotClass === 'ep_miner') {
          cloned.color.lerp(engGold, 0.14);
        }
      } else if (matName.includes('cover_plastic')) {
        cloned.transparent = true;
        cloned.opacity = 0.45;
      }
      cloned.needsUpdate = true;
    }

    clonedMaterials.set(mat, cloned);
    return cloned;
  };

  robot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const label = (obj.name || obj.parent?.name || '').toLowerCase();
    const isPrimarySilhouette =
      label.includes('chassis') ||
      label.includes('armor') ||
      label.includes('gimbal') ||
      label.includes('arm_1') ||
      label.includes('arm_2') ||
      label.includes('wheel');
    mesh.castShadow = isPrimarySilhouette;
    mesh.receiveShadow = false;
    if (mesh.geometry) {
      mesh.geometry.userData.sharedUrdfGeometry = true;
    }
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => mapMaterial(m, label));
    } else if (mesh.material) {
      mesh.material = mapMaterial(mesh.material, label);
    }
  });
}

/**
 * Instantiates an open-source DJI RoboMaster S1 (Striker) or RoboMaster EP (Miner Engineer) rig.
 */
export function buildRoboMasterCombatantRig(
  robotClass: RobotClass,
  team: TeamId,
  skinHex: string,
  beamHex: string,
  _isBot: boolean,
  contactShadowMap: THREE.Texture,
  onModelMounted?: () => void,
): RoboMasterCombatantRig {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  // Simplified proxy collision boxes matching ROBOT_HITBOX_SPECS[robotClass]
  const colliderMeshes: THREE.Mesh[] = [];
  const turretColliderPivot = new THREE.Group();
  root.add(turretColliderPivot);

  const hitboxParts = ROBOT_HITBOX_SPECS[robotClass] || ROBOT_HITBOX_SPECS.s1_striker;
  for (const part of hitboxParts) {
    const colliderBox = new THREE.Mesh(SHARED_COLLIDER_GEO, SHARED_COLLIDER_MAT);
    colliderBox.name = `collider_${robotClass}_${part.name}`;
    colliderBox.scale.set(part.w, part.h, part.d);
    colliderBox.position.set(part.localX, part.localY, part.localZ);
    colliderBox.castShadow = false;
    colliderBox.receiveShadow = false;
    colliderBox.userData = { isColliderBox: true, robotClass, part: part.name };
    if (part.useAimYaw) {
      turretColliderPivot.add(colliderBox);
    } else {
      root.add(colliderBox);
    }
    colliderMeshes.push(colliderBox);
  }

  const teamColor = team === 'cobalt' ? 0x06b6d4 : team === 'amber' ? 0xf59e0b : 0x10b981;
  const ringColor = robotClass === 'ep_miner' ? 0x10b981 : teamColor;

  // Ground contact shadow disc
  const shadowDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1.18, 24),
    new THREE.MeshBasicMaterial({ map: contactShadowMap, transparent: true, depthWrite: false, opacity: 0.66 }),
  );
  shadowDisc.rotation.x = -Math.PI / 2;
  shadowDisc.position.y = 0.015;
  root.add(shadowDisc);

  // Team & Class underglow silhouette ring
  const teamRing = new THREE.Mesh(
    new THREE.RingGeometry(0.84, 0.96, 32),
    new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  teamRing.rotation.x = -Math.PI / 2;
  teamRing.position.y = 0.022;
  root.add(teamRing);

  // Inner class ring for EP Miners (emerald-gold engineering marker)
  if (robotClass === 'ep_miner') {
    const engRing = new THREE.Mesh(
      new THREE.RingGeometry(0.68, 0.76, 24),
      new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    engRing.rotation.x = -Math.PI / 2;
    engRing.position.y = 0.026;
    root.add(engRing);
  }

  // Aegis Shield Gadget Dome
  const shieldDome = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.38, 1),
    new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.28, wireframe: true }),
  );
  shieldDome.position.y = 0.72;
  shieldDome.visible = false;
  root.add(shieldDome);

  // Overclock / Turbo Extraction ring
  const overclockRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.045, 8, 28),
    new THREE.MeshBasicMaterial({
      color: robotClass === 'ep_miner' ? 0xfbbf24 : 0x38bdf8,
      transparent: true,
      opacity: 0.85,
    }),
  );
  overclockRing.rotation.x = Math.PI / 2;
  overclockRing.position.y = 0.55;
  overclockRing.visible = false;
  root.add(overclockRing);

  let mountedRobot: URDFRobot | null = null;
  let muzzleNode: THREE.Object3D | null = null;
  let miningEmitterNode: THREE.Object3D | null = null;
  let wheelAngle = 0;
  let armCyclePhase = Math.random() * Math.PI * 2;
  let smoothedTurretYaw = 0;
  let smoothedArmLift = 0.2;

  getRoboMasterTemplate(robotClass)
    .then(({ robot: template, groundOffsetY }) => {
      if (root.userData.disposed) return;

      const clone = template.clone() as URDFRobot;
      tintClonedRobot(clone, robotClass, teamColor, skinHex, beamHex);

      // ROS URDF (+X fwd, +Y left, +Z up) -> Three.js (-Z fwd, -X left, +Y up)
      const orientOuter = new THREE.Group();
      const orientInner = new THREE.Group();
      orientInner.rotation.x = -Math.PI / 2;
      orientOuter.rotation.y = Math.PI / 2;
      orientOuter.scale.setScalar(ROBOMASTER_SCALE);
      orientOuter.position.y = groundOffsetY;

      orientInner.add(clone);
      orientOuter.add(orientInner);
      bodyGroup.add(orientOuter);
      mountedRobot = clone;

      // Attach combat muzzle anchor to blaster_link (S1) or upper camera_link emitter (EP),
      // and attach mining tether emitter to gripper_t_link (EP) so extended claw never clips walls when shooting.
      const muzzleTarget =
        robotClass === 'ep_miner'
          ? (clone.getObjectByName('camera_link') || clone.getObjectByName('arm_2_link') || clone)
          : (clone.getObjectByName('blaster_link') || clone);
      const muzzle = new THREE.Object3D();
      if (robotClass === 's1_striker') {
        muzzle.position.set(0.14, 0, 0.01);
      } else {
        muzzle.position.set(0.02, 0, 0.02);
      }
      muzzleTarget.add(muzzle);
      muzzleNode = muzzle;

      if (robotClass === 'ep_miner') {
        const gripperTarget =
          clone.getObjectByName('gripper_t_link') || clone.getObjectByName('camera_link') || clone;
        const gripperEmitter = new THREE.Object3D();
        gripperEmitter.position.set(0.03, 0, 0);
        gripperTarget.add(gripperEmitter);
        miningEmitterNode = gripperEmitter;
      } else {
        miningEmitterNode = muzzle;
      }

      onModelMounted?.();
    })
    .catch((err) => {
      console.error(`[RoboMaster ${robotClass} URDF] Failed to load model:`, err);
    });

  const getMuzzleWorldPos = (out: THREE.Vector3): THREE.Vector3 => {
    if (muzzleNode) {
      muzzleNode.getWorldPosition(out);
      return out;
    }
    root.getWorldPosition(out);
    out.y += robotClass === 'ep_miner' ? 0.98 : 1.05;
    return out;
  };

  const getMiningEmitterWorldPos = (out: THREE.Vector3): THREE.Vector3 => {
    if (miningEmitterNode) {
      miningEmitterNode.getWorldPosition(out);
      return out;
    }
    return getMuzzleWorldPos(out);
  };

  const animate = (
    stepDist: number,
    dt: number,
    aimPitch: number,
    turretRelYaw: number,
    isMining: boolean,
    isOverclocked: boolean,
  ) => {
    overclockRing.visible = isOverclocked;
    if (isOverclocked) {
      overclockRing.rotation.z += dt * 4.5;
      overclockRing.position.y = 0.45 + Math.sin(armCyclePhase * 3) * 0.14;
    }
    if (shieldDome.visible) {
      shieldDome.rotation.y += dt * 1.1;
    }

    if (!mountedRobot) return;

    const wheelRad = 0.05 * ROBOMASTER_SCALE;
    wheelAngle = (wheelAngle + stepDist / Math.max(0.05, wheelRad)) % (Math.PI * 2);
    mountedRobot.setJointValue('front_left_wheel_joint', wheelAngle);
    mountedRobot.setJointValue('front_right_wheel_joint', wheelAngle);
    mountedRobot.setJointValue('rear_left_wheel_joint', wheelAngle);
    mountedRobot.setJointValue('rear_right_wheel_joint', wheelAngle);

    if (robotClass === 's1_striker') {
      const targetYaw = THREE.MathUtils.clamp(turretRelYaw, -2.35, 2.35);
      const alpha = 1 - Math.exp(-16 * dt);
      smoothedTurretYaw += (targetYaw - smoothedTurretYaw) * alpha;
      turretColliderPivot.rotation.y = smoothedTurretYaw;
      mountedRobot.setJointValue('gimbal_joint', smoothedTurretYaw);
      mountedRobot.setJointValue('blaster_joint', THREE.MathUtils.clamp(-aimPitch, -0.45, 0.36));
    } else {
      // RoboMaster EP articulated arm & gripper animation
      armCyclePhase += dt * (isMining ? 4.8 : 1.4);
      const targetLift = isMining ? 0.52 + Math.sin(armCyclePhase) * 0.22 : 0.18 + Math.sin(armCyclePhase) * 0.04;
      smoothedArmLift += (targetLift - smoothedArmLift) * (1 - Math.exp(-8 * dt));
      const gripOsc = isMining ? 0.28 + Math.sin(armCyclePhase * 1.8) * 0.22 : 0.08;
      mountedRobot.setJointValue('arm_1_joint', THREE.MathUtils.clamp(smoothedArmLift, -0.25, 1.3));
      mountedRobot.setJointValue('rod_3_joint', isMining ? 0.35 + Math.cos(armCyclePhase) * 0.14 : 0.1);
      mountedRobot.setJointValue('rod_joint', THREE.MathUtils.clamp(-aimPitch * 0.45 + 0.15, -0.6, 1.2));
      mountedRobot.setJointValue('left_gripper_joint_1', gripOsc);
      mountedRobot.setJointValue('right_gripper_joint_1', -gripOsc);
    }
  };

  return {
    root,
    bodyGroup,
    colliderMeshes,
    shieldDome,
    overclockRing,
    robotClass,
    getMuzzleWorldPos,
    getMiningEmitterWorldPos,
    animate,
  };
}
