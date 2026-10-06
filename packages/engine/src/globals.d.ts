/**
 * `structuredClone` is available in Node and in every browser, but it is typed by the DOM / Node libraries that the
 * engine deliberately does not depend on. Plans and snapshots are plain JSON-style data, so this is all we use it for.
 */
declare function structuredClone<T>(value: T): T;
