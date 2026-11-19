import * as THREE from 'three';

export interface ProceduralTextureSet {
  floorMap: THREE.CanvasTexture;
  floorBump: THREE.CanvasTexture;
  wallMap: THREE.CanvasTexture;
  wallBump: THREE.CanvasTexture;
  barrierMap: THREE.CanvasTexture;
  reticleMap: THREE.CanvasTexture;
  contactShadowMap: THREE.CanvasTexture;
  dispose: () => void;
}

export function createArenaTextures(maxAnisotropy: number, accentHex: string): ProceduralTextureSet {
  // 1. Industrial Arena Floor Tile (SRGB albedo with micro-tread & seam details)
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 512;
  floorCanvas.height = 512;
  const fctx = floorCanvas.getContext('2d')!;
  fctx.fillStyle = '#0D131E';
  fctx.fillRect(0, 0, 512, 512);

  // Inner deck plate sub-panels with brushed industrial contrast
  for (let gx = 0; gx < 512; gx += 128) {
    for (let gy = 0; gy < 512; gy += 128) {
      fctx.fillStyle = (gx + gy) % 256 === 0 ? '#141C2B' : '#101724';
      fctx.fillRect(gx + 3, gy + 3, 122, 122);

      // Subtle micro-tread ticks
      fctx.fillStyle = '#1D293D';
      for (let tx = gx + 20; tx < gx + 112; tx += 22) {
        for (let ty = gy + 20; ty < gy + 112; ty += 22) {
          fctx.fillRect(tx, ty, 7, 2);
          fctx.fillRect(tx + 9, ty + 9, 2, 7);
        }
      }

      // Machined corner bolts
      fctx.fillStyle = '#3B4C66';
      fctx.fillRect(gx + 10, gy + 10, 5, 5);
      fctx.fillRect(gx + 113, gy + 10, 5, 5);
      fctx.fillRect(gx + 10, gy + 113, 5, 5);
      fctx.fillRect(gx + 113, gy + 113, 5, 5);
    }
  }

  // Deep recessed panel seams
  fctx.strokeStyle = '#070A10';
  fctx.lineWidth = 4;
  for (let i = 0; i <= 512; i += 128) {
    fctx.beginPath();
    fctx.moveTo(i, 0);
    fctx.lineTo(i, 512);
    fctx.stroke();
    fctx.beginPath();
    fctx.moveTo(0, i);
    fctx.lineTo(512, i);
    fctx.stroke();
  }

  // Crisp arena lane telemetry hairline
  fctx.strokeStyle = accentHex;
  fctx.globalAlpha = 0.28;
  fctx.lineWidth = 2;
  fctx.strokeRect(8, 8, 496, 496);
  fctx.globalAlpha = 1;

  const floorMap = new THREE.CanvasTexture(floorCanvas);
  floorMap.colorSpace = THREE.SRGBColorSpace;
  floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping;
  floorMap.repeat.set(16, 16);
  floorMap.anisotropy = maxAnisotropy;

  // 2. Floor Micro-Relief Bump Map (Linear space)
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 256;
  bumpCanvas.height = 256;
  const bctx = bumpCanvas.getContext('2d')!;
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, 256, 256);
  bctx.fillStyle = '#9A9A9A';
  for (let gx = 0; gx < 256; gx += 64) {
    for (let gy = 0; gy < 256; gy += 64) {
      for (let tx = gx + 10; tx < gx + 54; tx += 10) {
        for (let ty = gy + 10; ty < gy + 54; ty += 10) {
          bctx.fillRect(tx, ty, 3, 1);
          bctx.fillRect(tx + 4, ty + 4, 1, 3);
        }
      }
    }
  }
  bctx.strokeStyle = '#242424';
  bctx.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    bctx.strokeRect(i + 1, 1, 62, 254);
    bctx.strokeRect(1, i + 1, 254, 62);
  }
  const floorBump = new THREE.CanvasTexture(bumpCanvas);
  floorBump.wrapS = floorBump.wrapT = THREE.RepeatWrapping;
  floorBump.repeat.set(16, 16);
  floorBump.anisotropy = maxAnisotropy;

  // 3. Structural Armor Wall Plating (SRGB albedo + louver/panel seams)
  const wallCanvas = document.createElement('canvas');
  wallCanvas.width = 512;
  wallCanvas.height = 512;
  const wctx = wallCanvas.getContext('2d')!;
  wctx.fillStyle = '#182130';
  wctx.fillRect(0, 0, 512, 512);

  // Upper & lower armored bulkhead plates
  wctx.fillStyle = '#212D40';
  wctx.fillRect(16, 16, 480, 220);
  wctx.fillRect(16, 276, 480, 220);

  // Chamfered inner inset panels
  wctx.strokeStyle = '#334155';
  wctx.lineWidth = 4;
  wctx.strokeRect(16, 16, 480, 220);
  wctx.strokeRect(16, 276, 480, 220);

  // Recessed cooling louver slots on upper plate
  wctx.fillStyle = '#0F172A';
  for (let ly = 44; ly <= 104; ly += 18) {
    wctx.fillRect(48, ly, 160, 8);
    wctx.fillRect(304, ly, 160, 8);
  }

  // Hazard trim chevrons on lower plate border
  wctx.fillStyle = accentHex;
  wctx.globalAlpha = 0.72;
  wctx.fillRect(20, 250, 472, 12);
  wctx.globalAlpha = 0.3;
  for (let cx = 24; cx < 460; cx += 40) {
    wctx.beginPath();
    wctx.moveTo(cx, 488);
    wctx.lineTo(cx + 18, 488);
    wctx.lineTo(cx + 28, 470);
    wctx.lineTo(cx + 10, 470);
    wctx.closePath();
    wctx.fill();
  }
  wctx.globalAlpha = 1;

  const wallMap = new THREE.CanvasTexture(wallCanvas);
  wallMap.colorSpace = THREE.SRGBColorSpace;
  wallMap.wrapS = wallMap.wrapT = THREE.RepeatWrapping;
  wallMap.anisotropy = maxAnisotropy;

  // 4. Wall Micro-Relief Bump Map (Linear space)
  const wallBumpCanvas = document.createElement('canvas');
  wallBumpCanvas.width = 256;
  wallBumpCanvas.height = 256;
  const wbctx = wallBumpCanvas.getContext('2d')!;
  wbctx.fillStyle = '#707070';
  wbctx.fillRect(0, 0, 256, 256);
  wbctx.fillStyle = '#9C9C9C';
  wbctx.fillRect(8, 8, 240, 110);
  wbctx.fillRect(8, 138, 240, 110);
  wbctx.fillStyle = '#262626';
  for (let ly = 22; ly <= 52; ly += 9) {
    wbctx.fillRect(24, ly, 80, 4);
    wbctx.fillRect(152, ly, 80, 4);
  }
  wbctx.strokeStyle = '#383838';
  wbctx.lineWidth = 3;
  wbctx.strokeRect(8, 8, 240, 110);
  wbctx.strokeRect(8, 138, 240, 110);
  const wallBump = new THREE.CanvasTexture(wallBumpCanvas);
  wallBump.wrapS = wallBump.wrapT = THREE.RepeatWrapping;
  wallBump.anisotropy = maxAnisotropy;

  // 5. Destructible Energy Barrier Hexagonal Honeycomb Lattice
  const barCanvas = document.createElement('canvas');
  barCanvas.width = 256;
  barCanvas.height = 256;
  const brctx = barCanvas.getContext('2d')!;
  brctx.fillStyle = '#071426';
  brctx.fillRect(0, 0, 256, 256);

  const hexR = 22;
  const hexH = Math.sqrt(3) * hexR;
  brctx.strokeStyle = '#38BDF8';
  brctx.lineWidth = 2.5;
  for (let row = -1; row < 10; row++) {
    for (let col = -1; col < 10; col++) {
      const cx = col * hexR * 1.5;
      const cy = row * hexH + (col % 2 === 0 ? 0 : hexH * 0.5);
      brctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = cx + Math.cos(a) * (hexR - 2);
        const py = cy + Math.sin(a) * (hexR - 2);
        if (i === 0) brctx.moveTo(px, py);
        else brctx.lineTo(px, py);
      }
      brctx.closePath();
      brctx.stroke();
    }
  }
  // Subtle horizontal scanlines
  brctx.fillStyle = 'rgba(125, 211, 252, 0.14)';
  for (let sy = 0; sy < 256; sy += 16) {
    brctx.fillRect(0, sy, 256, 3);
  }

  const barrierMap = new THREE.CanvasTexture(barCanvas);
  barrierMap.colorSpace = THREE.SRGBColorSpace;
  barrierMap.wrapS = barrierMap.wrapT = THREE.RepeatWrapping;
  barrierMap.anisotropy = maxAnisotropy;

  // 6. Holographic Reflex Sight Reticle Texture
  const retCanvas = document.createElement('canvas');
  retCanvas.width = 128;
  retCanvas.height = 128;
  const rctx = retCanvas.getContext('2d')!;
  rctx.clearRect(0, 0, 128, 128);
  rctx.strokeStyle = '#FFFFFF';
  rctx.lineWidth = 4;
  rctx.beginPath();
  rctx.arc(64, 64, 34, 0.35, Math.PI - 0.35);
  rctx.stroke();
  rctx.beginPath();
  rctx.arc(64, 64, 34, Math.PI + 0.35, Math.PI * 2 - 0.35);
  rctx.stroke();
  rctx.fillStyle = '#FFFFFF';
  rctx.beginPath();
  rctx.arc(64, 64, 5, 0, Math.PI * 2);
  rctx.fill();
  rctx.fillRect(14, 62, 16, 4);
  rctx.fillRect(98, 62, 16, 4);
  const reticleMap = new THREE.CanvasTexture(retCanvas);
  reticleMap.colorSpace = THREE.SRGBColorSpace;

  // 7. Soft Radial Contact Shadow Disc
  const shadCanvas = document.createElement('canvas');
  shadCanvas.width = 128;
  shadCanvas.height = 128;
  const sctx = shadCanvas.getContext('2d')!;
  const grad = sctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.78)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.32)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 128, 128);
  const contactShadowMap = new THREE.CanvasTexture(shadCanvas);

  return {
    floorMap,
    floorBump,
    wallMap,
    wallBump,
    barrierMap,
    reticleMap,
    contactShadowMap,
    dispose: () => {
      floorMap.dispose();
      floorBump.dispose();
      wallMap.dispose();
      wallBump.dispose();
      barrierMap.dispose();
      reticleMap.dispose();
      contactShadowMap.dispose();
    },
  };
}
