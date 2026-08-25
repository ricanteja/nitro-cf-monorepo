/**
 * `$fetch` with the URL widened to a plain `string`.
 *
 * Nuxt matches template-literal URLs against its generated route table, and for
 * routes nested under a dynamic segment that comparison can exceed TypeScript's
 * instantiation depth — an error that names internal route types and points
 * nowhere near the real code. Widening opts out of the matching; response types
 * stay explicit at every call site.
 */
export function api<T = unknown>(url: string, options?: Record<string, unknown>): Promise<T> {
    return $fetch<T>(url, options as never) as Promise<T>
}
