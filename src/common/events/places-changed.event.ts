/**
 * Areas or their other names changed — an admin added "Badore" to Ajah, renamed an area
 * or switched one off. Whatever keeps a copy of the list (the chat's place matcher)
 * reads it again, so the change applies to the very next message.
 */
export const PLACES_CHANGED_EVENT = 'locations.places-changed';
