// Animated "Waves" background for the Home hero: one fullscreen triangle in a
// plain WebGL1 context, no libraries. It pauses while the tab is hidden or the
// hero is scrolled out of view, draws a single still frame for visitors who
// prefer reduced motion, and leaves the CSS background showing if WebGL is
// unavailable. The waves swirl gently around the pointer while it's over them.
import { useEffect, useRef } from "react";
import { cn } from "@etymos/shared";
import { WAVES_FRAGMENT_SHADER } from "./wavesShader";

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

// Low → high: #184557, #007FAD, #57B2CB, #EAF9FF, #007FAD; last three slots unused.
const COLORS = new Float32Array([
  0.094, 0.271, 0.341,
  0.0, 0.498, 0.678,
  0.341, 0.698, 0.796,
  0.918, 0.976, 1.0,
  0.0, 0.498, 0.678,
  0, 0, 0,
  0, 0, 0,
  0, 0, 0,
]);
const COLOR_COUNT = 5;

const MAX_DPR = 2;
const TIME_SCALE = 0.75;
// Cursor: swirl (effect 2.0), strength 0.04, radius 0.41.
const CURSOR_EFFECT = 2.0;
const CURSOR_STRENGTH = 0.04;
const CURSOR_RADIUS = 0.41;
// How quickly the swirl follows the pointer and fades in or out, per frame.
const CURSOR_EASE = 0.2;
// The waves are soft gradients, so drawing them at a fraction of the screen's
// pixels and letting the browser stretch the canvas looks the same while
// costing the GPU far less. At 0.25 on a 2× display, that's 1/16 of the pixels.
const RENDER_SCALE = 0.25;
// The motion is slow; 30 frames a second is indistinguishable from 60 here
// and halves the work again.
const FRAME_MS = 1000 / 30;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Waves shader failed to compile", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function ShaderBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      depth: false,
      stencil: false,
      // Lets a MacBook stay on its integrated GPU instead of waking the
      // discrete one, which is what makes laptops run hot.
      powerPreference: "low-power",
    });
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, WAVES_FRAGMENT_SHADER);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Waves shader failed to link", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    // One triangle that covers the whole clip space.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const loc = (name: string) => gl.getUniformLocation(program, name);
    const uScene = loc("u_scene");
    const uSpace = loc("u_space");
    const uCursor = loc("u_cursor");
    gl.uniform3fv(loc("u_colors"), COLORS);
    gl.uniform4f(loc("u_shape"), 1.88, 0.43, 0.71, 0.33);
    gl.uniform4f(loc("u_surface"), 1.73, 0.92, -0.03, 1.28);
    gl.uniform4f(loc("u_finish"), 0.0, 0.0, 0.0, 0.0);
    gl.uniform4f(loc("u_transform"), 3165.0, 3.4, 0.16, 0.0);

    // Pointer in the canvas's -1..1 space (y up, as in GL), eased each frame.
    const pointer = { x: 0, y: 0, inside: false };
    const cursor = { x: 0, y: 0, presence: 0 };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      pointer.inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      pointer.x = x * 2 - 1;
      pointer.y = 1 - y * 2;
    };
    const onPointerLeave = () => {
      pointer.inside = false;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const start = performance.now();
    const draw = (now: number) => {
      resize();
      if (cursor.presence < 0.001 && pointer.inside) {
        cursor.x = pointer.x; // start under the pointer instead of sliding in
        cursor.y = pointer.y;
      }
      cursor.x += (pointer.x - cursor.x) * CURSOR_EASE;
      cursor.y += (pointer.y - cursor.y) * CURSOR_EASE;
      cursor.presence += ((pointer.inside ? 1 : 0) - cursor.presence) * CURSOR_EASE;
      gl.uniform4f(uScene, canvas.width, canvas.height, ((now - start) / 1000) * TIME_SCALE, COLOR_COUNT);
      gl.uniform4f(uSpace, 0.1, -0.25, cursor.x, cursor.y);
      gl.uniform4f(uCursor, cursor.presence, CURSOR_EFFECT, CURSOR_STRENGTH, CURSOR_RADIUS);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let lastDraw = 0;
    let onScreen = true;
    const loop = (now: number) => {
      if (now - lastDraw >= FRAME_MS - 1) {
        lastDraw = now;
        draw(now);
      }
      frame = requestAnimationFrame(loop);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (still) {
        draw(start + 8000); // a settled frame, not the very first one
      } else if (onScreen && !document.hidden) {
        frame = requestAnimationFrame(loop);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      update();
    });
    observer.observe(canvas);
    const sizeObserver = new ResizeObserver(() => still && update());
    sizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", update);
    if (!still) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }
    update();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      sizeObserver.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 -z-10 block size-full", className)}
    />
  );
}
