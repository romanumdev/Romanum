import { readOwner } from "../accounts/session";
import { ensureGuestIdentity, isCrossSite } from "../guest";
import { historyDatabase } from "../history/database";
export const watchDependencies = { owner: readOwner, ensureIdentity: ensureGuestIdentity, isCrossSite, database: historyDatabase };
