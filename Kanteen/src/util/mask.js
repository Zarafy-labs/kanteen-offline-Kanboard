// Privacy masking for the "Make Board Unreadable" big-screen mode.
// Keeps the first letter of each word, stars the rest. Whitespace runs are
// preserved so the word/length shape stays intact (you can still sense the
// number and size of tasks) but the content can't be read at a glance.
export function maskText(text) {
  if (!text) return text;
  return String(text).replace(/\S+/g, (word) =>
    word.length <= 1 ? word : word[0] + '░'.repeat(word.length - 1)
  );
}
