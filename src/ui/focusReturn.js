/** One exact camera snapshot for returning from the latest deliberate object focus. */
export function createFocusReturn({ capture, restore, publish = () => {} }) {
  let previous = null;
  function focus(navigate) {
    const snapshot = capture();
    if (!snapshot) return false;
    const accepted = navigate();
    if (accepted === false) return false;
    previous = snapshot;
    publish(true);
    return true;
  }
  function back() {
    if (!previous) return false;
    restore(previous);
    previous = null;
    publish(false);
    return true;
  }
  return { focus, back };
}
