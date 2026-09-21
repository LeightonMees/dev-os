import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * A GLB/GLTF artifact drawn as the mesh it is, with orbit, pan and zoom. The
 * file is fetched from the control plane's raw endpoint, so nothing is decoded
 * from a JSON string and nothing is guessed about its size.
 *
 * Without WebGL (a headless test, a remote desktop with no GPU) the viewer says
 * so instead of rendering a black box. Numbers shown are read from the loaded
 * scene, not estimated.
 */
export function ModelViewer({ url, name }: { url: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ phase: "loading" | "ready" | "failed"; detail: string }>({ phase: "loading", detail: "" });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!webglAvailable()) {
      setState({ phase: "failed", detail: "WebGL is not available in this window, so the mesh cannot be drawn. Reveal the file to open it in a 3D tool." });
      return;
    }
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(3, 5, 4);
    scene.add(key);
    // A ground grid gives scale; it is sized from the model below.
    let grid: THREE.GridHelper | null = null;

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    let frame = 0;
    const tick = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };

    new GLTFLoader().load(
      url,
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        scene.add(root);
        // Frame the whole model whatever its units: fit its bounding sphere.
        const box = new THREE.Box3().setFromObject(root);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 1e-3);
        controls.target.copy(sphere.center);
        camera.position.copy(sphere.center).add(new THREE.Vector3(radius * 1.6, radius * 1.2, radius * 1.6));
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        grid = new THREE.GridHelper(radius * 4, 20, 0x555555, 0x333333);
        grid.position.y = box.min.y;
        scene.add(grid);
        let meshes = 0;
        let triangles = 0;
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          meshes += 1;
          const index = mesh.geometry.index;
          const position = mesh.geometry.attributes.position;
          triangles += Math.floor((index ? index.count : position ? position.count : 0) / 3);
        });
        const size = box.getSize(new THREE.Vector3());
        setState({ phase: "ready", detail: `${meshes} mesh${meshes === 1 ? "" : "es"} · ${triangles.toLocaleString()} triangles · ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}` });
        tick();
      },
      undefined,
      (error) => {
        if (disposed) return;
        setState({ phase: "failed", detail: `Could not load the model: ${(error as Error).message ?? String(error)}` });
      },
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of materials) m.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);

  return (
    <div className="artifact-model">
      <div className="artifact-model-stage" ref={host} role="img" aria-label={`${name}, 3D model`} />
      <div className="panel-strip">
        <span className="mono small">{state.phase === "ready" ? state.detail : state.phase === "loading" ? "Loading model…" : ""}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {state.phase === "ready" && <span className="dim small">drag to orbit · wheel to zoom · right-drag to pan</span>}
      </div>
      {state.phase === "failed" && <div className="artifact-note">{state.detail}</div>}
    </div>
  );
}

/** WebGL may be absent (headless, remote desktop, disabled); this asks rather than assumes. */
export function webglAvailable(): boolean {
  // A window without the WebGL interfaces cannot have a context; asking a canvas
  // for one there only produces a "not implemented" complaint.
  if (typeof window === "undefined" || !("WebGLRenderingContext" in window)) return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
