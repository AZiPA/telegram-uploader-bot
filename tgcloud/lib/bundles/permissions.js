import { canManageBundle, getBundle } from '../helpers.js';

export { canManageBundle };

export async function getManagedBundle(code, role, userId) {
  const row = await getBundle(code);
  const allowed = Boolean(row && (await canManageBundle(role, userId, row)));
  return { row, allowed };
}
