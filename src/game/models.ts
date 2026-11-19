import * as THREE from 'three';
import type { HazardDef, OreNodeDef, TeamId, WeaponId } from '../shared/types';

function createPolygonShape(pts: Array<[number, number]>): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();
  return shape;
}

function extrudeCenteredZ(
  pts: Array<[number, number]>,
  depth: number,
  bevelThickness = 0.012,
  bevelSize = 0.012,
  bevelSegments = 2,
): THREE.ExtrudeGeometry {
  const shape = createPolygonShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth,
    bevelEnabled: bevelThickness > 0 && bevelSize > 0,
    bevelThickness,
    bevelSize,
    bevelSegments,
  });
  geo.translate(0, 0, -depth * 0.5);
  return geo;
}

/**
 * Composite 10-part First-Person Laser Emitter Viewmodel (sculpted silhouettes per weapon)
 */
export function buildWeaponViewmodel(
  weaponId: WeaponId,
  skinHex: string,
  beamHex: string,
  reticleMap?: THREE.Texture,
): {
  group: THREE.Group;
  coreMat: THREE.MeshStandardMaterial;
  heatBarMat: THREE.MeshStandardMaterial;
  muzzleAnchor: THREE.Object3D;
} {
  const group = new THREE.Group();

  const hullMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skinHex),
    roughness: 0.36,
    metalness: 0.68,
    clearcoat: 0.65,
    clearcoatRoughness: 0.16,
  });
  const darkGripMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.86,
    metalness: 0.14,
  });
  const alloyMat = new THREE.MeshPhysicalMaterial({
    color: 0xb0bec5,
    roughness: 0.18,
    metalness: 0.92,
    anisotropy: 0.75,
  });
  const coreMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(beamHex),
    emissive: new THREE.Color(beamHex),
    emissiveIntensity: 1.85,
    roughness: 0.14,
    metalness: 0.2,
  });
  const heatBarMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(beamHex),
    emissive: new THREE.Color(beamHex),
    emissiveIntensity: 1.4,
    roughness: 0.2,
    metalness: 0.1,
  });

  // 1. Sculpted Beveled Receiver Body (side-profile extruded along X then centered)
  const receiverLen = weaponId === 'prism_railgun' ? 0.68 : weaponId === 'scatter_projector' ? 0.50 : 0.56;
  const receiverProfile: Array<[number, number]> =
    weaponId === 'prism_railgun'
      ? [
          [-0.055, -0.26],
          [0.045, -0.26],
          [0.068, -0.02],
          [0.052, 0.38],
          [-0.025, 0.42],
          [-0.055, 0.18],
        ]
      : weaponId === 'scatter_projector'
        ? [
            [-0.06, -0.20],
            [0.055, -0.20],
            [0.072, 0.08],
            [0.062, 0.30],
            [-0.045, 0.30],
            [-0.065, 0.02],
          ]
        : [
            [-0.052, -0.22],
            [0.048, -0.22],
            [0.062, 0.04],
            [0.046, 0.32],
            [-0.032, 0.34],
            [-0.052, 0.08],
          ];

  const receiverShape = createPolygonShape(receiverProfile);
  const receiverW = weaponId === 'scatter_projector' ? 0.105 : 0.072;
  const receiverGeo = new THREE.ExtrudeGeometry(receiverShape, {
    steps: 1,
    depth: receiverW,
    bevelEnabled: true,
    bevelThickness: 0.011,
    bevelSize: 0.01,
    bevelSegments: 2,
  });
  // Center extrusion thickness on Z, then map (height=u, forward=v, width=w) -> (x=-w, y=u, z=-v)
  receiverGeo.translate(0, 0, -receiverW * 0.5);
  receiverGeo.rotateX(-Math.PI / 2);
  receiverGeo.rotateZ(Math.PI / 2);
  receiverGeo.translate(0, 0, -0.14);
  const receiver = new THREE.Mesh(receiverGeo, hullMat);
  group.add(receiver);

  // 2. Ergonomic Contoured Grip & Trigger Guard
  const gripGeo = extrudeCenteredZ(
    [
      [-0.036, 0],
      [0.036, 0],
      [0.024, -0.14],
      [-0.042, -0.14],
    ],
    0.046,
    0.008,
    0.008,
    2,
  );
  gripGeo.rotateY(Math.PI / 2);
  const grip = new THREE.Mesh(gripGeo, darkGripMat);
  grip.position.set(0, -0.04, 0.03);
  grip.rotation.x = 0.24;
  group.add(grip);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 6, 12, Math.PI), darkGripMat);
  guard.rotation.y = Math.PI / 2;
  guard.rotation.z = Math.PI;
  guard.position.set(0, -0.055, -0.03);
  group.add(guard);

  // 3. Rear Angled Stock & Cheek Rest
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.085, 0.14), darkGripMat);
  stock.position.set(0, -0.015, 0.14);
  group.add(stock);

  // 4. Weapon-Specific Barrel & Emitter Assemblies
  let muzzleZ = -receiverLen * 0.95;

  if (weaponId === 'prism_railgun') {
    // Twin Split Magnetic Accelerator Rails + Helical Cooling Coils + Turned Lens
    for (const ry of [0.046, -0.022]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.024, 0.48), alloyMat);
      rail.position.set(0, ry, -0.46);
      group.add(rail);
    }
    const channelCore = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.46, 8), coreMat);
    channelCore.rotation.x = Math.PI / 2;
    channelCore.position.set(0, 0.012, -0.44);
    group.add(channelCore);

    for (const cz of [-0.30, -0.39, -0.48, -0.57]) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.007, 6, 14), alloyMat);
      coil.position.set(0, 0.012, cz);
      group.add(coil);
    }

    const lathePts = [
      new THREE.Vector2(0.012, 0),
      new THREE.Vector2(0.034, 0.02),
      new THREE.Vector2(0.038, 0.07),
      new THREE.Vector2(0.024, 0.10),
    ];
    const focusBell = new THREE.Mesh(new THREE.LatheGeometry(lathePts, 14), alloyMat);
    focusBell.rotation.x = -Math.PI / 2;
    focusBell.position.set(0, 0.012, -0.64);
    group.add(focusBell);
    muzzleZ = -0.74;
  } else if (weaponId === 'scatter_projector') {
    // Tri-Barrel Delta Emitter Cluster + Wide Heat Sink Shroud
    const barrelPts = [
      new THREE.Vector2(0.014, 0),
      new THREE.Vector2(0.022, 0.03),
      new THREE.Vector2(0.020, 0.16),
      new THREE.Vector2(0.026, 0.21),
    ];
    const chokeGeo = new THREE.LatheGeometry(barrelPts, 12);
    const offsets: Array<[number, number]> = [
      [-0.038, 0.005],
      [0.038, 0.005],
      [0, 0.042],
    ];
    for (const [bx, by] of offsets) {
      const barrel = new THREE.Mesh(chokeGeo, alloyMat);
      barrel.rotation.x = -Math.PI / 2;
      barrel.position.set(bx, by, -0.35);
      group.add(barrel);

      const tipGlow = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.005, 6, 12), coreMat);
      tipGlow.position.set(bx, by, -0.56);
      group.add(tipGlow);
    }
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.118, 0.085, 0.18), darkGripMat);
    shroud.position.set(0, 0.02, -0.40);
    group.add(shroud);
    muzzleZ = -0.57;
  } else {
    // Pulse Carbine: Turned Fluted Barrel + Curved Coolant Conduit Tube + Heat-Sink Fins
    const carbineBarrelPts = [
      new THREE.Vector2(0.015, 0),
      new THREE.Vector2(0.026, 0.04),
      new THREE.Vector2(0.022, 0.24),
      new THREE.Vector2(0.030, 0.28),
      new THREE.Vector2(0.020, 0.32),
    ];
    const barrel = new THREE.Mesh(new THREE.LatheGeometry(carbineBarrelPts, 14), alloyMat);
    barrel.rotation.x = -Math.PI / 2;
    barrel.position.set(0, 0.016, -0.34);
    group.add(barrel);

    // Side glowing coolant conduit tube (TubeGeometry)
    const conduitCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.044, 0.02, -0.08),
      new THREE.Vector3(-0.056, 0.03, -0.24),
      new THREE.Vector3(-0.042, 0.015, -0.42),
    ]);
    const conduit = new THREE.Mesh(new THREE.TubeGeometry(conduitCurve, 12, 0.008, 6, false), coreMat);
    group.add(conduit);

    // Upper vented shroud ribs
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.016, 0.024), darkGripMat);
      fin.position.set(0, 0.056, -0.32 - i * 0.052);
      group.add(fin);
    }
    muzzleZ = -0.66;
  }

  // 5. Recessed Side Energy Core & Heat Telemetry Bar
  const sideCore = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.022, 0.26), heatBarMat);
  sideCore.position.set(-receiverW * 0.5 - 0.008, 0.018, -0.18);
  group.add(sideCore);

  // 6. Sculpted Holographic Reflex Sight Arch + Etched Reticle Glass
  const opticBase = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.018, 0.095), darkGripMat);
  opticBase.position.set(0, 0.072, -0.13);
  group.add(opticBase);

  const hoodCurve = new THREE.TorusGeometry(0.028, 0.0055, 6, 14, Math.PI);
  const hood = new THREE.Mesh(hoodCurve, alloyMat);
  hood.position.set(0, 0.082, -0.13);
  group.add(hood);

  const opticGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.044, 0.036),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(beamHex),
      map: reticleMap ?? null,
      transparent: true,
      opacity: reticleMap ? 0.9 : 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  opticGlass.position.set(0, 0.098, -0.13);
  group.add(opticGlass);

  // 7. Muzzle Emitter Ring + Anchor
  const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.007, 8, 16), coreMat);
  muzzle.position.set(0, 0.014, muzzleZ);
  group.add(muzzle);

  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.014, muzzleZ - 0.04);
  group.add(muzzleAnchor);

  return { group, coreMat, heatBarMat, muzzleAnchor };
}

export {
  buildRoboMasterCombatantRig,
  preloadAllRoboMasterTemplates,
  type RoboMasterCombatantRig,
} from './robomasterModel';

/**
 * Composite 7-part Destructible Barrier Assembly with Tapered Stanchions & Hex Lattice
 */
export function buildDestructibleBarrier(
  w: number,
  h: number,
  d: number,
  barrierMap: THREE.Texture,
): { group: THREE.Group; coreMesh: THREE.Mesh; coreMat: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x162030, roughness: 0.55, metalness: 0.72 });
  const alloyMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.3, metalness: 0.85 });
  const coreMat = new THREE.MeshStandardMaterial({
    map: barrierMap,
    color: 0xffffff,
    emissive: 0x0284c7,
    emissiveIntensity: 0.95,
    roughness: 0.2,
    metalness: 0.25,
    transparent: true,
    opacity: 0.84,
  });

  const spanX = w >= d;
  const pylonOffset = (spanX ? w : d) * 0.45;
  const stanchionGeo = extrudeCenteredZ(
    [
      [-0.22, -h * 0.5],
      [0.22, -h * 0.5],
      [0.14, h * 0.5],
      [-0.14, h * 0.5],
    ],
    0.26,
    0.03,
    0.025,
    2,
  );
  if (!spanX) stanchionGeo.rotateY(Math.PI / 2);

  for (const sign of [-1, 1]) {
    const pylon = new THREE.Mesh(stanchionGeo, frameMat);
    pylon.position.set(spanX ? sign * pylonOffset : 0, 0, spanX ? 0 : sign * pylonOffset);
    pylon.castShadow = true;
    pylon.receiveShadow = true;
    group.add(pylon);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.32), alloyMat);
    cap.position.set(spanX ? sign * pylonOffset : 0, h * 0.48, spanX ? 0 : sign * pylonOffset);
    group.add(cap);
  }

  // Top/Bottom projector rails
  const railW = spanX ? w : 0.34;
  const railD = spanX ? 0.34 : d;
  const topRail = new THREE.Mesh(new THREE.BoxGeometry(railW, 0.14, railD), alloyMat);
  topRail.position.y = h * 0.45;
  group.add(topRail);

  const botRail = new THREE.Mesh(new THREE.BoxGeometry(railW + 0.08, 0.22, railD + 0.08), frameMat);
  botRail.position.y = -h * 0.44;
  group.add(botRail);

  // Hexagonal Energy Core Pane
  const coreMesh = new THREE.Mesh(
    new THREE.BoxGeometry(spanX ? w * 0.84 : w * 0.42, h * 0.78, spanX ? d * 0.42 : d * 0.84),
    coreMat,
  );
  group.add(coreMesh);

  return { group, coreMesh, coreMat };
}

/**
 * Composite Environmental Hazard Assemblies (Lathe, Tube & Extrude details)
 */
export function buildHazardAssembly(def: HazardDef): {
  group: THREE.Group;
  ringMat: THREE.MeshBasicMaterial;
  coreMesh: THREE.Object3D;
  sweeperBeam?: THREE.Mesh;
} {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);

  const colorHex =
    def.kind === 'plasma_pylon' ? 0xf59e0b : def.kind === 'coolant_leak' ? 0x38bdf8 : 0xef4444;

  // Floor Hazard Radius Ring (+0.025 Y offset)
  const ringMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(def.radius - 0.26, def.radius, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  group.add(ring);

  const baseMat = new THREE.MeshStandardMaterial({ color: 0x162030, roughness: 0.48, metalness: 0.74 });
  const alloyMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.25, metalness: 0.88 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 1.35,
    roughness: 0.18,
    metalness: 0.22,
  });

  // Tiered Lathe Base Pedestal
  const pedestalPts = [
    new THREE.Vector2(0.0, 0),
    new THREE.Vector2(0.92, 0),
    new THREE.Vector2(0.84, 0.16),
    new THREE.Vector2(0.68, 0.24),
    new THREE.Vector2(0.62, 0.36),
    new THREE.Vector2(0.0, 0.36),
  ];
  const base = new THREE.Mesh(new THREE.LatheGeometry(pedestalPts, 12), baseMat);
  group.add(base);

  const coreMesh = new THREE.Group();
  coreMesh.position.y = 0.9;
  group.add(coreMesh);

  let sweeperBeam: THREE.Mesh | undefined;

  if (def.kind === 'plasma_pylon') {
    // Tiered Tesla Induction Spire
    const spirePts = [
      new THREE.Vector2(0.36, -0.54),
      new THREE.Vector2(0.28, -0.10),
      new THREE.Vector2(0.42, 0.0),
      new THREE.Vector2(0.24, 0.10),
      new THREE.Vector2(0.38, 0.45),
      new THREE.Vector2(0.20, 0.55),
      new THREE.Vector2(0.32, 0.92),
      new THREE.Vector2(0.14, 1.08),
    ];
    const spire = new THREE.Mesh(new THREE.LatheGeometry(spirePts, 12), alloyMat);
    coreMesh.add(spire);

    for (let i = 0; i < 3; i++) {
      const ang = (i * Math.PI * 2) / 3;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.34), baseMat);
      fin.position.set(Math.cos(ang) * 0.44, 0.15, Math.sin(ang) * 0.44);
      fin.rotation.y = -ang + Math.PI / 2;
      coreMesh.add(fin);
    }

    const orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.38, 0), glowMat);
    orb.position.y = 1.48;
    coreMesh.add(orb);

    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.055, 8, 20), glowMat);
    halo.position.y = 1.48;
    halo.rotation.x = Math.PI / 3;
    coreMesh.add(halo);
  } else if (def.kind === 'coolant_leak') {
    // Domed Cryo Canisters + Curved TubeGeometry Transfer Pipes
    const tankPts = [
      new THREE.Vector2(0.0, 0),
      new THREE.Vector2(0.18, 0),
      new THREE.Vector2(0.18, 0.72),
      new THREE.Vector2(0.13, 0.86),
      new THREE.Vector2(0.0, 0.92),
    ];
    const tankGeo = new THREE.LatheGeometry(tankPts, 12);
    for (const ang of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
      const tx = Math.cos(ang) * 0.40;
      const tz = Math.sin(ang) * 0.40;
      const tank = new THREE.Mesh(tankGeo, glowMat);
      tank.position.set(tx, -0.54, tz);
      coreMesh.add(tank);

      const pipeCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(tx, 0.34, tz),
        new THREE.Vector3(tx * 0.65, 0.56, tz * 0.65),
        new THREE.Vector3(0, 0.44, 0),
      ]);
      const pipe = new THREE.Mesh(new THREE.TubeGeometry(pipeCurve, 10, 0.045, 6, false), alloyMat);
      coreMesh.add(pipe);
    }
    const ventCap = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 0.36, 10), baseMat);
    ventCap.position.y = 0.32;
    coreMesh.add(ventCap);
  } else {
    // Heavy Armored Laser Sweeper Turret Head
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.36, 12), baseMat);
    collar.position.y = -0.34;
    coreMesh.add(collar);

    const turretBody = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.44, 0.64), alloyMat);
    turretBody.position.y = -0.05;
    coreMesh.add(turretBody);

    for (const lx of [-0.46, 0.46]) {
      const lensHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.24, 10), glowMat);
      lensHousing.rotation.z = Math.PI / 2;
      lensHousing.position.set(lx, -0.08, 0);
      coreMesh.add(lensHousing);
    }

    sweeperBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, def.radius * 2, 8),
      new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.92 }),
    );
    sweeperBeam.rotation.z = Math.PI / 2;
    sweeperBeam.position.y = -0.08;
    coreMesh.add(sweeperBeam);
  }

  return { group, ringMat, coreMesh, sweeperBeam };
}

/**
 * Iconic Central Dual-Gyroscope Prism Reactor Spire (visible from spawns & title orbit)
 */
export function buildCentralLandmark(accentHex: string): {
  group: THREE.Group;
  spinner: THREE.Group;
  innerSpinner: THREE.Group;
} {
  const group = new THREE.Group();
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x131c2b, roughness: 0.42, metalness: 0.8 });
  const alloyMat = new THREE.MeshPhysicalMaterial({
    color: 0x94a3b8,
    roughness: 0.22,
    metalness: 0.9,
    clearcoat: 0.4,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accentHex),
    emissive: new THREE.Color(accentHex),
    emissiveIntensity: 1.5,
    roughness: 0.16,
    metalness: 0.35,
  });

  // 1. Turned Octagonal Base Reactor Socket
  const basePts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(2.65, 0),
    new THREE.Vector2(2.45, 0.5),
    new THREE.Vector2(2.15, 0.85),
    new THREE.Vector2(1.4, 1.05),
    new THREE.Vector2(0, 1.05),
  ];
  const baseSocket = new THREE.Mesh(new THREE.LatheGeometry(basePts, 8), darkMetal);
  group.add(baseSocket);

  const socketRing = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.08, 8, 24), accentMat);
  socketRing.rotation.x = Math.PI / 2;
  socketRing.position.y = 1.04;
  group.add(socketRing);

  // 2. 4 Tapered Angled Architectural Buttress Ribs (ExtrudeGeometry)
  const ribShape = createPolygonShape([
    [1.8, 0.8],
    [2.6, 0.8],
    [2.95, 4.4],
    [2.35, 7.6],
    [1.85, 7.6],
    [2.25, 4.4],
  ]);
  const ribGeo = new THREE.ExtrudeGeometry(ribShape, {
    steps: 1,
    depth: 0.46,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 2,
  });
  ribGeo.translate(0, 0, -0.23);

  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    const rib = new THREE.Mesh(ribGeo, darkMetal);
    rib.rotation.y = ang;
    rib.castShadow = true;
    group.add(rib);

    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.14, 5.2, 0.12), accentMat);
    trim.position.set(Math.cos(ang) * 2.15, 4.2, Math.sin(ang) * 2.15);
    trim.rotation.y = -ang;
    group.add(trim);
  }

  // 3. Upper Containment Halo Crown
  const collar = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.24, 10, 32), alloyMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 7.6;
  group.add(collar);

  const upperCrown = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.10, 8, 24), accentMat);
  upperCrown.rotation.x = Math.PI / 2;
  upperCrown.position.y = 8.25;
  group.add(upperCrown);

  // 4. Dual Counter-Rotating Gyroscope Rings + Multi-Faceted Prism Core
  const spinner = new THREE.Group();
  spinner.position.y = 4.65;

  const outerGyro = new THREE.Mesh(new THREE.TorusGeometry(1.92, 0.09, 8, 28), alloyMat);
  spinner.add(outerGyro);

  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(1.15, 0), accentMat);
  crystal.scale.set(0.95, 1.75, 0.95);
  spinner.add(crystal);

  const innerSpinner = new THREE.Group();
  const innerGyro = new THREE.Mesh(new THREE.TorusGeometry(1.48, 0.065, 8, 24), accentMat);
  innerGyro.rotation.x = Math.PI / 2.6;
  innerSpinner.add(innerGyro);
  spinner.add(innerSpinner);

  group.add(spinner);

  return { group, spinner, innerSpinner };
}

/**
 * Mineral Ore Vein Node (Aurum / Cryo Crystal Cluster + Mining Socket Ring)
 */
export function buildOreNodeAssembly(def: OreNodeDef): {
  group: THREE.Group;
  crystalGroup: THREE.Group;
  crystalMat: THREE.MeshPhysicalMaterial;
  ringMat: THREE.MeshBasicMaterial;
  haloMesh: THREE.Mesh;
} {
  const group = new THREE.Group();
  group.position.set(def.x, def.y, def.z);

  const isRich = def.tier === 'rich';
  const crystalColor = isRich ? 0xfbbf24 : 0x34d399;
  const socketColor = 0x162030;

  // Ground extraction radius ring
  const ringMat = new THREE.MeshBasicMaterial({
    color: crystalColor,
    transparent: true,
    opacity: 0.36,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.9, 5.2, 42), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.024;
  group.add(ring);

  // Industrial Hex Socket Plinth
  const plinthMat = new THREE.MeshStandardMaterial({ color: socketColor, roughness: 0.45, metalness: 0.78 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.28, metalness: 0.85 });
  const basePts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(1.45, 0),
    new THREE.Vector2(1.28, 0.22),
    new THREE.Vector2(0.95, 0.32),
    new THREE.Vector2(0, 0.32),
  ];
  const base = new THREE.Mesh(new THREE.LatheGeometry(basePts, 6), plinthMat);
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.06, 6, 6), rimMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.28;
  group.add(collar);

  // Translucent Emissive Mineral Crystal Cluster
  const crystalMat = new THREE.MeshPhysicalMaterial({
    color: crystalColor,
    emissive: crystalColor,
    emissiveIntensity: isRich ? 1.15 : 0.9,
    roughness: 0.14,
    metalness: 0.18,
    clearcoat: 0.85,
    clearcoatRoughness: 0.1,
  });

  const crystalGroup = new THREE.Group();
  crystalGroup.position.y = 0.28;
  group.add(crystalGroup);

  const shardSpecs: Array<[number, number, number, number, number, number]> = [
    [0, 0, 0.48, 2.2, 0.05, 0.05],
    [0.42, 0.25, 0.26, 1.35, 0.28, -0.22],
    [-0.44, 0.18, 0.28, 1.45, -0.25, 0.3],
    [0.18, -0.45, 0.24, 1.2, -0.32, -0.18],
    [-0.25, -0.38, 0.22, 1.1, 0.22, 0.28],
  ];

  for (const [sx, sz, rad, h, rx, rz] of shardSpecs) {
    const geo = new THREE.ConeGeometry(rad, h * (isRich ? 1.18 : 1.0), 6);
    geo.translate(0, h * 0.45, 0);
    const shard = new THREE.Mesh(geo, crystalMat);
    shard.position.set(sx, 0, sz);
    shard.rotation.set(rx, Math.random() * Math.PI, rz);
    shard.castShadow = true;
    crystalGroup.add(shard);
  }

  // Hovering orbital energy halo
  const haloMesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.92, 0.045, 8, 24),
    new THREE.MeshBasicMaterial({ color: crystalColor, transparent: true, opacity: 0.72 }),
  );
  haloMesh.rotation.x = Math.PI / 2.3;
  haloMesh.position.y = 1.65;
  crystalGroup.add(haloMesh);

  return { group, crystalGroup, crystalMat, ringMat, haloMesh };
}

