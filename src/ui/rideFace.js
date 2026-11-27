import { msg } from '../i18n/index.js';

// The face of a card's lead entry button: the view it enters. An aircraft's
// cockpit, a satellite's orbital view and a vessel's bridge are built in; a
// Cockpit subject provider's item (cockpitSubjectProviders.js) shows the
// provider's own `entryFace` while entry would ride that very item; anything
// else that can be entered (a train, a bus) shows the cab view.
const RIDE_FACES = Object.freeze({
  flights: { icon: 'flight', label: msg('Enter Cockpit') },
  military: { icon: 'flight', label: msg('Enter Cockpit') },
  satellites: { icon: 'satellite_alt', label: msg('Orbital view') },
  'ais-live-vessels': { icon: 'directions_boat', label: msg('Bridge view') },
});
const CAB_VIEW = Object.freeze({ icon: 'train', label: msg('Cab view') });

/**
 * @param {?{layerId?: string, identity?: {id?: *}}} card The open card.
 * @param {?object} presence The Cockpit's published presence (its entry
 *   fields: entryAvailable, entryLayerId, entryId, entryFace).
 * @returns {{icon: string, label: string}}
 */
export function rideFaceFor(card, presence) {
  const builtIn = RIDE_FACES[card?.layerId];
  if (builtIn) return builtIn;
  const face = presence?.entryAvailable ? presence.entryFace : null;
  const sameItem =
    face &&
    presence.entryLayerId === card?.layerId &&
    presence.entryId != null &&
    card?.identity?.id != null &&
    String(presence.entryId) === String(card.identity.id);
  return sameItem ? face : CAB_VIEW;
}
