// Local DEMO session for the ORYN prototype.
//
// There is no identity provider, no password check and no server. Signing in
// records display fields in this browser only. Every surface that shows the
// session labels it as a demo session; see docs/ORYN_PROTOTYPE.md.
import { createCollection } from './store.js';
import { validateSession } from './models.js';

export const DEMO_ORGANIZATIONS = Object.freeze([
  Object.freeze({
    id: 'demo-city',
    name: 'City of Example (DEMO)',
    workspace: 'municipal',
  }),
  Object.freeze({
    id: 'demo-county-em',
    name: 'County Emergency Management (DEMO)',
    workspace: 'operations',
  }),
  Object.freeze({
    id: 'demo-coop',
    name: 'Valley Growers Cooperative (DEMO)',
    workspace: 'agriculture',
  }),
  Object.freeze({
    id: 'demo-transit',
    name: 'Regional Transit Authority (DEMO)',
    workspace: 'transportation',
  }),
]);

export const DEMO_ROLES = Object.freeze([
  'analyst',
  'operator',
  'administrator',
]);

export function createSessionStore({ storage } = {}) {
  const collection = createCollection(
    'session',
    (value) => {
      const session = validateSession(value);
      return session ? { id: 'current', ...session } : null;
    },
    { storage },
  );
  return Object.freeze({
    current: () => collection.get('current'),
    /** Start a demo session. Nothing is verified; the record is labeled demo. */
    signIn({ user, organizationId, role }) {
      const organization =
        DEMO_ORGANIZATIONS.find((entry) => entry.id === organizationId) ??
        DEMO_ORGANIZATIONS[0];
      return collection.put({
        id: 'current',
        user,
        organization: organization.name,
        organizationId: organization.id,
        workspace: organization.workspace,
        role: DEMO_ROLES.includes(role) ? role : 'analyst',
        startedAt: new Date().toISOString(),
        demo: true,
      });
    },
    signOut: () => collection.remove('current'),
    subscribe: collection.subscribe,
  });
}
