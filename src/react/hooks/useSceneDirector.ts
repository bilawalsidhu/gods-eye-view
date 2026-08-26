/**
 * useSceneDirector — typed hook to access the SceneDirector from React.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSD(): any { return ((window as any).__godsEyeView?.sceneDirector) ?? null; }

export function useSceneDirector() {
  return { sceneDirector: getSD() };
}
