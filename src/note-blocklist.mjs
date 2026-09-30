// A deliberately small, local slur/abuse list for holder notes. Operators hide anything it misses.
// Words are matched whole (plural "s" allowed) after folding case, accents and common leetspeak.
const WORDS = ['nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'kike', 'spic', 'chink', 'tranny', 'wetback', 'coon', 'cunt', 'dyke', 'gook', 'raghead', 'beaner']
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' }
const PATTERN = new RegExp(`(?:^|[^a-z])(?:${WORDS.join('|')})s?(?=$|[^a-z])`)

export function blockedWord(text) {
  const folded = String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[!|](?=[a-z])/g, 'i').replace(/[0134578@$]/g, c => LEET[c]).replace(/(.)\1{2,}/g, '$1$1')
  return PATTERN.test(folded) || PATTERN.test(folded.replace(/(.)\1+/g, '$1'))
}
