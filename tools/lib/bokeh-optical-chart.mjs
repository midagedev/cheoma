export const BOKEH_OPTICAL_CHART_VIEWPORT = Object.freeze({
  width: 960,
  height: 600,
});

export async function installBokehOpticalChart(page, threeModuleUrl) {
  return page.evaluate(
    async ({ moduleUrl, viewport }) => {
      const { width, height } = viewport;
      const THREE = await import(moduleUrl);
      const engine = window.__engine;
      engine.setViewShiftEnabled(false);
      engine.setWeather("clear");
      engine.setSeason("summer", { immediate: true });
      engine.setTime("night", { immediate: true });
      engine.debugSetPaused(true);

      // Detach (do not dispose) the product roots for this transient page. The real
      // composer, camera and update/debug paths remain in place, while the depth pass
      // traverses only the optical chart and its counters stay easy to interpret.
      for (const child of [...engine.scene.children])
        engine.scene.remove(child);
      engine.scene.background = new THREE.Color(0x01030a);
      engine.scene.fog = null;

      const chart = new THREE.Group();
      chart.name = "bokeh-optical-chart";
      engine.scene.add(chart);
      const controls = [];

      const material = (r, g, b) =>
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(r, g, b),
          fog: false,
        });
      const addBox = (name, size, position, color) => {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(...size),
          material(...color),
        );
        mesh.name = name;
        mesh.position.set(...position);
        chart.add(mesh);
        return mesh;
      };

      // A quiet, deep backdrop gives both light banks room to form clean discs.
      addBox("backdrop", [520, 300, 1], [0, 0, -220], [0.002, 0.004, 0.012]);

      // Focus-plane subject: a restrained, gate-like chart with fine edges. It is
      // deliberately below the bloom threshold, so sharpness is attributable to DoF.
      addBox(
        "focus-field",
        [20, 20, 0.35],
        [0, 0, -0.35],
        [0.006, 0.009, 0.016],
      );
      addBox(
        "focus-left-post",
        [1.1, 14, 1.5],
        [-4.6, 0, 0],
        [0.075, 0.105, 0.14],
      );
      addBox(
        "focus-right-post",
        [1.1, 14, 1.5],
        [4.6, 0, 0],
        [0.075, 0.105, 0.14],
      );
      addBox(
        "focus-lower-roof",
        [14, 0.75, 1.8],
        [0, 6.1, 0],
        [0.16, 0.09, 0.045],
      );
      addBox(
        "focus-upper-roof",
        [10.8, 0.58, 1.9],
        [0, 7.25, 0],
        [0.24, 0.15, 0.065],
      );
      addBox(
        "focus-sill",
        [10.2, 0.45, 1.2],
        [0, -6.5, 0],
        [0.055, 0.075, 0.1],
      );
      const focusRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.15, 0.17, 12, 64),
        material(0.28, 0.22, 0.11),
      );
      focusRing.name = "focus-plane-ring";
      focusRing.position.z = 0.9;
      chart.add(focusRing);
      addBox(
        "focus-needle-v",
        [0.12, 5.5, 0.8],
        [0, 0, 1.0],
        [0.18, 0.22, 0.26],
      );
      addBox(
        "focus-needle-h",
        [5.5, 0.12, 0.8],
        [0, 0, 1.0],
        [0.18, 0.22, 0.26],
      );
      controls.push(
        addBox(
          "focus-edge-control",
          [5.0, 0.25, 0.8],
          [0, 4.0, 1.0],
          [0.22, 0.17, 0.09],
        ),
      );

      const lights = [];
      const sphere = new THREE.SphereGeometry(1, 16, 12);
      const addLight = (name, position, radius, color, collection = lights) => {
        const mesh = new THREE.Mesh(sphere, material(...color));
        mesh.name = name;
        mesh.position.set(...position);
        mesh.scale.setScalar(radius);
        chart.add(mesh);
        collection.push(mesh);
      };

      // At camera z=100 these banks sit 20m in front and 240m behind the focus
      // plane. The default 0.00015 aperture therefore reaches the product max-blur
      // radius on both sides, making the aperture shape legible without exaggeration.
      // Source radii are chosen for similar ~4px emissive faces before DoF despite
      // the different perspective scales. This models a lantern/firefly glow rather
      // than an unattainable mathematical delta, while remaining much smaller than
      // the resulting aperture image.
      addLight(
        "foreground-amber-left",
        [-5.9, 3.8, 80],
        0.04,
        [11.0, 4.2, 0.75],
      );
      addLight(
        "foreground-open-pair",
        [-3.6, -1.4, 80],
        0.04,
        [11.0, 4.2, 0.75],
      );
      addLight(
        "foreground-rose-right",
        [6.1, 2.1, 80],
        0.04,
        [10.5, 1.7, 1.15],
      );
      addLight(
        "foreground-moon-left",
        [-6.6, -3.6, 80],
        0.04,
        [3.0, 5.8, 11.0],
      );
      addLight(
        "foreground-gold-right",
        [5.7, -4.0, 80],
        0.04,
        [12.0, 6.2, 1.0],
      );
      // The same source over the opaque focus field must retain its aperture disc
      // through the bounded source-depth branch rather than only its bloom halo.
      addLight(
        "foreground-over-focus",
        [1.4, -1.4, 80],
        0.04,
        [11.0, 4.2, 0.75],
      );

      // Negative controls sit just outside opposite focus-card edges. The dim near
      // bar has valid foreground depth but no HDR energy; the far HDR sphere is
      // visible beside the card but is behind its depth. Neither may bleed inward.
      addLight(
        "dim-foreground-bar",
        [-2.08, 0, 80],
        0.04,
        [0.2, 0.14, 0.08],
        controls,
      );
      addLight(
        "background-edge-control",
        [25.2, 12.0, -140],
        0.4,
        [12.0, 5.4, 0.8],
        controls,
      );

      addLight("background-gold-left", [-58, 30, -140], 0.4, [12.0, 5.4, 0.8]);
      addLight("background-blue-left", [-53, -31, -140], 0.4, [2.4, 5.0, 11.5]);
      addLight("background-rose-right", [58, 27, -140], 0.4, [11.0, 1.8, 1.0]);
      addLight(
        "background-amber-right",
        [55, -33, -140],
        0.4,
        [12.0, 6.5, 1.1],
      );

      const camera = engine.camera;
      camera.position.set(0, 0, 100);
      camera.near = 0.1;
      camera.far = 500;
      camera.fov = 35;
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
      engine.__controls.target.set(0, 0, 0);
      camera.lookAt(engine.__controls.target);
      camera.updateMatrixWorld(true);
      // Finish any load-time camera handoff, then establish the chart's exact focus
      // depth once before the 0-vs-default pair. Both captures start from one state.
      if (engine.debugDof().tweenProgress != null)
        engine.debugDofSeek(1, { finish: true });
      camera.position.set(0, 0, 100);
      camera.fov = 35;
      camera.updateProjectionMatrix();
      engine.__controls.target.set(0, 0, 0);
      camera.lookAt(engine.__controls.target);
      camera.updateMatrixWorld(true);
      engine.debugTuneDof({ amount: 1, aperture: 0.00015, maxBlur: 0.01 });
      for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
      engine.debugRenderDofFrame();

      const projectObjects = (objects) =>
        objects.map((object) => {
          const worldCenter = object.getWorldPosition(new THREE.Vector3());
          const worldRim = object.localToWorld(new THREE.Vector3(0, 1, 0));
          const p = worldCenter.project(camera);
          const rim = worldRim.project(camera);
          return {
            name: object.name,
            x: Math.round((p.x * 0.5 + 0.5) * width),
            y: Math.round((-p.y * 0.5 + 0.5) * height),
            diameterPx: Math.hypot(
              (rim.x - p.x) * width,
              (rim.y - p.y) * height,
            ),
          };
        });
      const cardCorners = [
        new THREE.Vector3(-10, -10, -0.175),
        new THREE.Vector3(10, 10, -0.175),
      ].map((point) => point.project(camera));
      return {
        projectedLights: projectObjects(lights),
        projectedControls: projectObjects(controls),
        focusCardBounds: {
          left: Math.round((cardCorners[0].x * 0.5 + 0.5) * width),
          right: Math.round((cardCorners[1].x * 0.5 + 0.5) * width),
          top: Math.round((-cardCorners[1].y * 0.5 + 0.5) * height),
          bottom: Math.round((-cardCorners[0].y * 0.5 + 0.5) * height),
        },
        focusDepth: 100,
        fixtureDrawCalls: chart.children.length,
      };
    },
    {
      moduleUrl: threeModuleUrl,
      viewport: BOKEH_OPTICAL_CHART_VIEWPORT,
    },
  );
}
