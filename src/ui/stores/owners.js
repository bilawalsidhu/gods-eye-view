/**
 * The owners answering a store's controls. A view calls `act(name, ...args)`;
 * the newest connected owner with an action of that name answers it, so an
 * owner that connects again replaces itself, and owners of different actions
 * sit side by side.
 * @returns {{connect: Function, detach: Function, act: Function}}
 */
export function createOwners() {
  /** @type {Array<{actions: object}>} Oldest first. */
  const owners = [];

  /**
   * Answer the actions named in `actions`.
   * @param {Record<string, Function>} actions
   * @returns {object} Token for detach().
   */
  function connect(actions) {
    const token = { actions };
    owners.push(token);
    return token;
  }

  /** Stop answering for the owner holding `token`; the others stay. */
  function detach(token) {
    const index = owners.indexOf(token);
    if (index >= 0) owners.splice(index, 1);
  }

  /**
   * A control's change: call the newest connected owner's action of that
   * name, if any.
   * @param {string} name
   * @param {...unknown} args
   * @returns {unknown} What the action returned, if one answered.
   */
  function act(name, ...args) {
    for (let index = owners.length - 1; index >= 0; index -= 1) {
      const action = owners[index].actions[name];
      if (action) return action(...args);
    }
  }

  return { connect, detach, act };
}
