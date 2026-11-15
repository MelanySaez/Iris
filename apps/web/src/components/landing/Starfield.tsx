import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

export interface StarfieldHandle {
  /** Accelerates the stars into the screen; resolves when the jump ends. */
  warp: () => Promise<void>;
}

interface Star {
  x: number;
  y: number;
  z: number;
  warm: boolean;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const STAR_COUNT = 1100;
const DEPTH = 1000;
const CRUISE_SPEED = 0.03; // depth units per ms: a slow drift towards the viewer
const WARP_MS = 900;
/** Half-width of the star volume in depth units, so far stars fill the screen. */
const SPREAD = DEPTH * 1.1;
/** How far (px) the sky shifts as the pointer goes from the centre to an edge. */
const POINTER_SHIFT_X = 120;
const POINTER_SHIFT_Y = 80;

/** Small deterministic generator so the sky is the same on every visit. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Full-screen star field behind the landing: stars at different depths drift
 * slowly towards the viewer, follow the pointer by depth, and a meteor crosses
 * now and then. `warp()` accelerates them into streaks for the jump into the
 * viewer. With reduced motion it is drawn once and `warp()` resolves at once.
 */
export function Starfield({ ref }: { ref?: Ref<StarfieldHandle> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const warpRef = useRef<{ start: number; done: () => void } | null>(null);
  const liveRef = useRef(false);

  useImperativeHandle(ref, () => ({
    warp: () =>
      new Promise<void>((resolve) => {
        if (!liveRef.current) {
          resolve();
          return;
        }
        warpRef.current = { start: performance.now(), done: resolve };
      }),
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    const still = prefersReducedMotion();
    liveRef.current = !still;
    const rand = seeded(20260315);
    const spawn = (z = rand() * DEPTH): Star => ({
      x: (rand() - 0.5) * 2 * SPREAD,
      y: (rand() - 0.5) * 2 * SPREAD,
      z,
      warm: rand() > 0.93,
    });
    const stars = Array.from({ length: STAR_COUNT }, () => spawn());
    let meteor: Meteor | null = null;
    let nextMeteor = performance.now() + 2500;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = performance.now();
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const scroll = Number(getComputedStyle(canvas).getPropertyValue('--landing-scroll')) || 0;

      // Warp: speed eases up to ~40x cruise, streaks lengthen, then resolve.
      let boost = 1;
      const warp = warpRef.current;
      if (warp) {
        const t = Math.min(1, (now - warp.start) / WARP_MS);
        boost = 1 + 40 * t * t * t;
        if (t >= 1) {
          warpRef.current = null;
          warp.done();
        }
      }

      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      const cx = width / 2 - pointer.x * POINTER_SHIFT_X * 2;
      const cy = height / 2 - pointer.y * POINTER_SHIFT_Y * 2 - scroll * height * 0.25;
      const focal = Math.max(width, height) * 0.6;

      ctx.fillStyle = warp ? `rgba(0, 0, 0, ${0.35})` : '#000';
      ctx.fillRect(0, 0, width, height);

      for (const star of stars) {
        const prevZ = star.z;
        if (!still) star.z -= CRUISE_SPEED * boost * dt;
        if (star.z <= 1) Object.assign(star, spawn(DEPTH));
        const k = focal / star.z;
        const x = cx + star.x * k;
        const y = cy + star.y * k;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) {
          Object.assign(star, spawn(DEPTH));
          continue;
        }
        const near = 1 - star.z / DEPTH;
        const alpha = 0.55 + near * 0.45;
        const color = star.warm ? '245, 217, 168' : '233, 237, 245';
        if (boost > 2) {
          const pk = focal / prevZ;
          ctx.strokeStyle = `rgba(${color}, ${alpha})`;
          ctx.lineWidth = 0.4 + near * 1.6;
          ctx.beginPath();
          ctx.moveTo(cx + star.x * pk, cy + star.y * pk);
          ctx.lineTo(x, y);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${color}, ${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, 0.7 + near * near * 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (!still && !warp) {
        if (!meteor && now > nextMeteor) {
          meteor = {
            x: width * (0.3 + rand() * 0.6),
            y: height * rand() * 0.35,
            vx: -(0.5 + rand() * 0.4),
            vy: 0.25 + rand() * 0.2,
            life: 1,
          };
          nextMeteor = now + 5000 + rand() * 7000;
        }
        if (meteor) {
          const tail = 90;
          const gradient = ctx.createLinearGradient(
            meteor.x, meteor.y, meteor.x - meteor.vx * tail, meteor.y - meteor.vy * tail,
          );
          gradient.addColorStop(0, `rgba(255, 244, 222, ${0.9 * meteor.life})`);
          gradient.addColorStop(1, 'rgba(255, 244, 222, 0)');
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(meteor.x, meteor.y);
          ctx.lineTo(meteor.x - meteor.vx * tail, meteor.y - meteor.vy * tail);
          ctx.stroke();
          meteor.x += meteor.vx * dt;
          meteor.y += meteor.vy * dt;
          meteor.life -= dt / 1400;
          if (meteor.life <= 0) meteor = null;
        }
      }
    };

    const loop = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      last = performance.now();
      if (still) draw(last);
      else frame = requestAnimationFrame(loop);
    };

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(frame);
      else start();
    };
    const onResize = () => {
      resize();
      if (still) draw(performance.now());
    };
    const onPointer = (event: PointerEvent) => {
      pointer.tx = event.clientX / Math.max(1, width) - 0.5;
      pointer.ty = event.clientY / Math.max(1, height) - 0.5;
    };

    resize();
    start();
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      liveRef.current = false;
      warpRef.current?.done();
      warpRef.current = null;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="landing-stars" aria-hidden="true" />;
}
