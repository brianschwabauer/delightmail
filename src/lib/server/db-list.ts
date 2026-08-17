/**
 * Reading rows out of the mailbox DO.
 *
 * `DatabaseServer.list()` answers in the search engine's shape — `{ count, elapsed, facets, hits,
 * cursor }`, where each hit wraps the row in `.document`. It does **not** return `docs`.
 * `docs` exists only on the *client's* reactive search, and every server-side caller here
 * had copied that field name across, reaching for `res.docs` and silently getting
 * `undefined` — which then threw on `.length` / `[0]`.
 *
 * Nothing type-checked it because each call site cast the result with
 * `as unknown as { docs: … }` first. It would have taken down the Gmail connect callback
 * (accountCount) and web-push subscribe the first time either ran. Go through here.
 */

export interface ListableDb {
	list(entity_type: string, query: Record<string, unknown>): Promise<unknown> | unknown;
}

interface ListResults {
	count?: number;
	hits?: { document?: unknown }[];
}

/**
 * List rows of an entity, returning the documents themselves.
 *
 * `sparse: false` so callers get whole rows rather than only the fields that happen to be
 * in the search index — every caller here wants a real record (an id to write against, a
 * row to hand back). Pass `sparse: true` in `query` to opt out.
 */
export async function listDocs<T>(
	db: ListableDb,
	entity_type: string,
	query: Record<string, unknown> = {},
): Promise<T[]> {
	const res = (await db.list(entity_type, { sparse: false, ...query })) as ListResults | undefined;
	return (res?.hits ?? []).map((hit) => hit.document as T).filter((doc) => doc != null);
}

/** How many rows of an entity exist (capped by `limit`, default 100). */
export async function countDocs(
	db: ListableDb,
	entity_type: string,
	query: Record<string, unknown> = {},
): Promise<number> {
	const res = (await db.list(entity_type, { limit: 100, sparse: true, ...query })) as
		| ListResults
		| undefined;
	// `count` is the total match count, independent of the page size — but fall back to the
	// page length if a DO answers without it.
	return res?.count ?? res?.hits?.length ?? 0;
}
