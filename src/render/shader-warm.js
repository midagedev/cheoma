// Safely precompile a short-lived subtree against an existing scene. three.js
// WebGLRenderer.compileAsync() assumes every material remains registered until
// its polling loop finishes. Focus rings and reroll subtrees can be disposed
// earlier, which leaves currentProgram undefined and raises a global isReady
// TypeError outside the returned Promise. Missing programs here mean the owner
// has already been released, so they are simply removed from the pending set.
export function compileSubtreeAsync(renderer, root, camera, targetScene = null) {
  if (!renderer?.compile || !root || !camera) return Promise.resolve(root);

  let materials;
  try {
    materials = renderer.compile(root, camera, targetScene);
  } catch {
    return Promise.resolve(root);
  }
  if (!(materials instanceof Set) || materials.size === 0) return Promise.resolve(root);

  return new Promise((resolve) => {
    const poll = () => {
      for (const material of materials) {
        let program;
        try {
          program = renderer.properties?.get(material)?.currentProgram;
        } catch {
          materials.delete(material);
          continue;
        }
        if (!program) { materials.delete(material); continue; }
        try {
          if (program.isReady()) materials.delete(material);
        } catch {
          materials.delete(material);
        }
      }
      if (materials.size === 0) resolve(root);
      else setTimeout(poll, 10);
    };
    setTimeout(poll, 10);
  });
}
