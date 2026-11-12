import * as THREE from 'three';

/**
 * Generates a crisp 1024x1024 architectural facade texture atlas (4 horizontal style bands of 256px each).
 * Texture uses flipY = false so v = canvasY / 1024 directly:
 *   Band 0 (v: 0.004..0.246): Brazilian residential house stucco + recessed framed windows + shutters + base plinth
 *   Band 1 (v: 0.254..0.496): Multi-story condo/apartment building (4 floor rows, balconies, mullions, slab lines)
 *   Band 2 (v: 0.504..0.746): Commercial / retail (glass storefront ground level + architectural upper panels)
 *   Band 3 (v: 0.754..0.996): Warehouse / shopping / industrial (ribbed architectural panels + clerestory ribbon windows)
 */
export function createFacadeAtlasTexture(maxAnisotropy = 4): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const drawWindow = (
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { lit?: boolean; balcony?: boolean; frameCol?: string; glassTop?: string; glassBot?: string; shutters?: boolean } = {}
  ) => {
    const frameCol = opts.frameCol || '#334155';
    // Outer shadow recess
    ctx.fillStyle = 'rgba(15,23,42,0.28)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

    // Frame
    ctx.fillStyle = frameCol;
    ctx.fillRect(x, y, w, h);

    // Glass pane with sky-to-horizon gradient or warm interior glow
    const pad = Math.max(2, Math.round(w * 0.09));
    const gx = x + pad;
    const gy = y + pad;
    const gw = w - pad * 2;
    const gh = h - pad * 2;

    const grad = ctx.createLinearGradient(gx, gy, gx, gy + gh);
    if (opts.lit) {
      grad.addColorStop(0, '#475569');
      grad.addColorStop(0.45, '#64748b');
      grad.addColorStop(0.55, '#d97706');
      grad.addColorStop(1, '#fbbf24');
    } else {
      grad.addColorStop(0, opts.glassTop || '#4b6584');
      grad.addColorStop(0.55, opts.glassBot || '#2c3e50');
      grad.addColorStop(1, '#1e293b');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(gx, gy, gw, gh);

    // Diagonal sky reflection highlight
    ctx.fillStyle = 'rgba(226,232,240,0.22)';
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + gw * 0.65, gy);
    ctx.lineTo(gx, gy + gh * 0.72);
    ctx.closePath();
    ctx.fill();

    // Window divider / mullion
    ctx.fillStyle = frameCol;
    ctx.fillRect(gx + gw * 0.48, gy, Math.max(2, gw * 0.06), gh);

    // Window sill
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(x - 3, y + h, w + 6, 4);
    ctx.fillStyle = 'rgba(15,23,42,0.22)';
    ctx.fillRect(x - 3, y + h + 4, w + 6, 3);

    if (opts.shutters && w >= 24) {
      ctx.fillStyle = 'rgba(51,65,85,0.55)';
      ctx.fillRect(x - Math.round(w * 0.24), y + 1, Math.round(w * 0.22), h - 2);
      ctx.fillRect(x + w + 2, y + 1, Math.round(w * 0.22), h - 2);
    }

    if (opts.balcony) {
      const bY = y + h * 0.64;
      const bH = h * 0.44;
      ctx.fillStyle = 'rgba(15,23,42,0.35)';
      ctx.fillRect(x - 6, bY + bH - 5, w + 12, 6);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(x - 7, bY + bH - 9, w + 14, 5);
      // Glass / rail bars
      ctx.fillStyle = 'rgba(148,163,184,0.42)';
      ctx.fillRect(x - 6, bY, w + 12, bH - 9);
      ctx.fillStyle = '#334155';
      ctx.fillRect(x - 7, bY, w + 14, 3);
      for (let bx = x - 4; bx <= x + w + 4; bx += 7) {
        ctx.fillRect(bx, bY, 2, bH - 9);
      }
    }
  };

  // --- BAND 0 (0..256): Residential Brazilian House ---
  {
    const y0 = 0;
    const bh = 256;
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(0, y0, size, bh);

    // Subtle stucco plaster texture noise
    for (let i = 0; i < 3600; i++) {
      const nx = (i * 197) % size;
      const ny = y0 + ((i * 73) % bh);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(120,113,108,0.055)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(nx, ny, 3, 2);
    }

    // Under-eave shadow at top
    const eaveGrad = ctx.createLinearGradient(0, y0, 0, y0 + 36);
    eaveGrad.addColorStop(0, 'rgba(15,23,42,0.42)');
    eaveGrad.addColorStop(1, 'rgba(15,23,42,0)');
    ctx.fillStyle = eaveGrad;
    ctx.fillRect(0, y0, size, 36);

    // 8 residential bays across 1024px (128px each bay = ~3m)
    for (let bay = 0; bay < 8; bay++) {
      const bx = bay * 128;
      if (bay % 3 === 1) {
        // Recessed entrance door + small window
        ctx.fillStyle = '#475569';
        ctx.fillRect(bx + 26, y0 + 82, 42, 134);
        ctx.fillStyle = '#6b4226';
        ctx.fillRect(bx + 30, y0 + 86, 34, 130);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(bx + 35, y0 + 94, 24, 42);
        drawWindow(bx + 82, y0 + 86, 34, 58, { lit: bay === 4 });
      } else {
        drawWindow(bx + 32, y0 + 78, 64, 74, { lit: bay === 2 || bay === 6, shutters: bay % 2 === 0 });
      }
    }

    // Stone / masonry ground plinth at bottom
    ctx.fillStyle = '#b6ada2';
    ctx.fillRect(0, y0 + bh - 34, size, 34);
    ctx.fillStyle = 'rgba(15,23,42,0.22)';
    ctx.fillRect(0, y0 + bh - 36, size, 3);
  }

  // --- BAND 1 (256..512): Multi-Story Apartment / Condominio (4 floor rows) ---
  {
    const y0 = 256;
    const bh = 256;
    ctx.fillStyle = '#e8edf2';
    ctx.fillRect(0, y0, size, bh);

    // Vertical structural columns
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = 'rgba(148,163,184,0.26)';
      ctx.fillRect(c * 128, y0, 12, bh);
    }

    const floorH = bh / 4; // 64px per floor
    for (let fl = 0; fl < 4; fl++) {
      const fy = y0 + fl * floorH;
      // Concrete slab band
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(0, fy, size, 7);
      ctx.fillStyle = 'rgba(15,23,42,0.16)';
      ctx.fillRect(0, fy + 7, size, 2);

      for (let bay = 0; bay < 8; bay++) {
        const bx = bay * 128;
        const lit = (fl * 7 + bay * 3) % 5 === 0;
        drawWindow(bx + 26, fy + 14, 76, 38, {
          lit,
          balcony: bay % 2 === 1 && fl < 3,
          frameCol: '#1e293b',
        });
      }
    }
  }

  // --- BAND 2 (512..768): Commercial / Office / Retail ---
  {
    const y0 = 512;
    const bh = 256;
    ctx.fillStyle = '#dbe2ea';
    ctx.fillRect(0, y0, size, bh);

    // Upper architectural curtain wall / office floors (top 60%)
    for (let fl = 0; fl < 2; fl++) {
      const fy = y0 + fl * 74 + 8;
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(0, fy, size, 5);
      for (let bay = 0; bay < 8; bay++) {
        drawWindow(bay * 128 + 14, fy + 11, 100, 52, {
          lit: (bay + fl) % 4 === 0,
          frameCol: '#1e293b',
          glassTop: '#38bdf8',
          glassBot: '#1e3a5f',
        });
      }
    }

    // Storefront cornice / awning
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, y0 + 156, size, 12);
    ctx.fillStyle = 'rgba(15,23,42,0.35)';
    ctx.fillRect(0, y0 + 168, size, 6);

    // Ground floor commercial glass shopfronts
    for (let bay = 0; bay < 4; bay++) {
      const bx = bay * 256 + 14;
      drawWindow(bx, y0 + 174, 228, 72, {
        lit: bay % 2 === 0,
        frameCol: '#0f172a',
        glassTop: '#64748b',
        glassBot: '#334155',
      });
    }
  }

  // --- BAND 3 (768..1024): Industrial / Shopping / Warehouse ---
  {
    const y0 = 768;
    const bh = 256;
    ctx.fillStyle = '#d6dce3';
    ctx.fillRect(0, y0, size, bh);

    // Vertical corrugated ribbing
    for (let x = 0; x < size; x += 16) {
      ctx.fillStyle = x % 32 === 0 ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, y0, 6, bh);
    }

    // Precast pilaster columns
    for (let bx = 0; bx < size; bx += 256) {
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(bx, y0, 20, bh);
    }

    // Top parapet coping
    ctx.fillStyle = '#64748b';
    ctx.fillRect(0, y0, size, 14);

    // High clerestory ribbon windows
    for (let bay = 0; bay < 4; bay++) {
      drawWindow(bay * 256 + 30, y0 + 40, 212, 44, {
        frameCol: '#334155',
        glassTop: '#475569',
        glassBot: '#1e293b',
      });
    }

    // Lower concrete dado wall
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(0, y0 + 170, size, 86);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a single lightweight volumetric 3D tree BufferGeometry (~110 triangles)
 * with baked vertex colors (warm bark trunk + shaded multi-cluster crown).
 * Neutral crown colors are white-to-light-grey so per-instance satellite green tinting shines naturally.
 */
export function createTreePrototypeGeometry(): THREE.BufferGeometry {
  const parts: Array<{ geo: THREE.BufferGeometry; r: number; g: number; b: number; shadeBot?: number }> = [];

  // Trunk (height ~2.8m in normalized 6m tree prototype)
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 2.2, 5, 1);
  trunk.translate(0, 1.1, 0);
  parts.push({ geo: trunk, r: 0.42, g: 0.3, b: 0.22 });

  // Lower main canopy lobe
  const crown1 = new THREE.IcosahedronGeometry(1.75, 1);
  crown1.scale(1.12, 0.85, 1.08);
  crown1.translate(0, 3.2, 0);
  parts.push({ geo: crown1, r: 0.92, g: 0.95, b: 0.92, shadeBot: 0.62 });

  // Upper offset canopy lobe
  const crown2 = new THREE.IcosahedronGeometry(1.25, 1);
  crown2.scale(1.0, 0.92, 1.0);
  crown2.translate(0.45, 4.35, 0.25);
  parts.push({ geo: crown2, r: 1.02, g: 1.05, b: 1.0, shadeBot: 0.72 });

  // Side foliage cluster
  const crown3 = new THREE.IcosahedronGeometry(1.05, 1);
  crown3.translate(-0.65, 3.7, -0.35);
  parts.push({ geo: crown3, r: 0.88, g: 0.92, b: 0.88, shadeBot: 0.65 });

  // Merge non-indexed geometries cleanly into one single BufferGeometry
  let totalVerts = 0;
  const expanded = parts.map((p) => {
    const nonIdx = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    nonIdx.computeVertexNormals();
    totalVerts += nonIdx.attributes.position.count;
    return { ...p, geo: nonIdx };
  });

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);

  let offset = 0;
  for (const part of expanded) {
    const pos = part.geo.attributes.position;
    const norm = part.geo.attributes.normal;
    const count = pos.count;
    for (let i = 0; i < count; i++) {
      const idx = (offset + i) * 3;
      const py = pos.getY(i);
      positions[idx] = pos.getX(i);
      positions[idx + 1] = py;
      positions[idx + 2] = pos.getZ(i);
      normals[idx] = norm.getX(i);
      normals[idx + 1] = norm.getY(i);
      normals[idx + 2] = norm.getZ(i);

      const shade = part.shadeBot ? Math.min(1.05, part.shadeBot + Math.max(0, (py - 2.0) / 3.4) * (1.05 - part.shadeBot)) : 1.0;
      colors[idx] = part.r * shade;
      colors[idx + 1] = part.g * shade;
      colors[idx + 2] = part.b * shade;
    }
    offset += count;
    part.geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}
