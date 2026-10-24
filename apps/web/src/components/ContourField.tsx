"use client";

import { useEffect, useRef } from "react";
import { onSurge, surgeSpeed } from "@/lib/motion";
import styles from "./ContourField.module.css";

/*
 * The page's ground: a slow field of fine contour lines, like the map of a familiar walk. A smooth
 * noise height field is cut into level lines; every fifth line is a little stronger, as on a survey
 * map. The field drifts very slowly, and when the assistant replies (surge()) it flows faster for a
 * moment, the way the ground moves when you start walking. Written for this project. Lines are drawn
 * at CSS-pixel resolution with derivative-based anti-aliasing; the loop runs at about 30 fps, stops
 * while the tab is hidden, and draws one still frame under reduced motion. Without WebGL (or the
 * derivatives extension) the plain paper underneath shows instead.
 */

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
#extension GL_OES_standard_derivatives : enable
precision mediump float;
uniform vec2 u_size;
uniform float u_time;
uniform float u_dark;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float height(vec2 p, float t) {
  float h = 0.0;
  float amp = 0.55;
  vec2 drift = vec2(t * 0.018, -t * 0.011);
  for (int i = 0; i < 3; i++) {
    h += amp * noise(p + drift);
    p = p * 1.9 + vec2(1.3, 4.1);
    drift *= -1.3;
    amp *= 0.45;
  }
  return h;
}

void main() {
  vec2 p = gl_FragCoord.xy / u_size.y * 2.2;
  float level = height(p, u_time) * 11.0;
  float w = fwidth(level);
  float d = abs(fract(level - 0.5) - 0.5) / max(w, 1e-4);
  float line = 1.0 - smoothstep(0.35, 1.25, d);
  float major = step(4.5, mod(floor(level + 0.5), 5.0));

  // The paper and ink tokens in globals.css (#f1f4f2 / #14201c light, #101513 / #e6ece9 dark).
  vec3 paper = mix(vec3(0.945, 0.957, 0.949), vec3(0.063, 0.082, 0.075), u_dark);
  vec3 ink = mix(vec3(0.078, 0.125, 0.11), vec3(0.902, 0.925, 0.914), u_dark);
  float strength = mix(0.085, 0.16, major) * mix(1.0, 0.75, u_dark);

  // Fade the field toward the left, where people read, so the conversation sits on calm paper.
  float calm = smoothstep(0.05, 0.55, gl_FragCoord.x / u_size.x);
  gl_FragColor = vec4(mix(paper, ink, line * strength * (0.45 + 0.55 * calm)), 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function ContourField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!canvas || !gl || !gl.getExtension("OES_standard_derivatives")) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    // One triangle that covers the screen.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uSize = gl.getUniformLocation(program, "u_size");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uDark = gl.getUniformLocation(program, "u_dark");

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    let time = 23.7;
    let last = performance.now();
    let drawn = 0;
    let surgeAt = -Infinity;
    let raf = 0;

    const draw = () => {
      gl.uniform2f(uSize, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uDark, dark.matches ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.dataset.ready = "true";
    };
    const resize = () => {
      // CSS pixels, not device pixels: fine lines stay crisp enough, and the field costs a quarter as much.
      canvas.width = Math.max(1, Math.round(canvas.clientWidth));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight));
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw();
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - last);
      last = now;
      time += (dt / 1000) * surgeSpeed(now - surgeAt, 1500, 6);
      // About 30 frames a second is plenty for a field this slow.
      if (now - drawn >= 32) {
        drawn = now;
        draw();
      }
    };
    const start = () => {
      if (raf || reduce.matches || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onReduce = () => {
      if (reduce.matches) {
        stop();
        draw();
      } else start();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", onReduce);
    dark.addEventListener("change", draw);
    const offSurge = onSurge(() => {
      surgeAt = performance.now();
    });
    resize();
    start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", onReduce);
      dark.removeEventListener("change", draw);
      offSurge();
    };
  }, []);

  return (
    <div className={styles.ground} aria-hidden="true">
      <canvas ref={ref} className={styles.canvas} />
    </div>
  );
}
