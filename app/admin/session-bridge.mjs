// Module memory only. This bridge grants no server authority on its own.
let session = null;
export function setOwnerSession(value) {
  if (!value || typeof value.getAccessToken !== "function")
    throw new TypeError("Invalid owner session");
  session = value;
}
export function getOwnerSession() {
  return session;
}
export function clearOwnerSession() {
  session?.clear();
  session = null;
}
