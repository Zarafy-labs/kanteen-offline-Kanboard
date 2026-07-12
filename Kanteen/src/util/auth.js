// UTF-8-safe HTTP Basic auth header. Plain btoa() throws InvalidCharacterError
// on any non-Latin-1 character in the username or token; PHP decodes Basic
// credentials as raw bytes, so UTF-8 encoding round-trips correctly.
export function basicAuth(username, pat) {
  const bytes = new TextEncoder().encode(`${username}:${pat}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}
