/**
 * SceneDirectorPanel — placeholder confirming React integration for the scene panel.
 *
 * The #scene-panel DOM is owned by vanilla JS (index.html).
 * useSceneDirector() hook provides typed access to the scene director.
 */
import React from 'react';
import { useSceneDirector } from '../hooks/useSceneDirector';

export function SceneDirectorPanel(): React.JSX.Element {
  // #scene-panel already exists in index.html — do not re-declare.
  // useSceneDirector hook lets other components interact with the director.
  void useSceneDirector();
  return <></>;
}
