/**
 * Tidies a line a model wrote before it is checked, shown or spoken. Live replies sometimes carry a stray
 * character: on 2026-10-25, 3 of 6 live onboarding runs ended an acknowledgement "isn't built yet..", and a
 * demo recording showed "isn't built yet.}". Retrying the model for that would cost seconds, so the server
 * cleans it instead. It removes characters that never belong in plain chat copy (braces, brackets, angle
 * brackets, backticks, asterisks), turns a doubled full stop into one (a real ellipsis is left for the copy
 * rules to refuse), drops a full stop after "?" or "!" and a comma before end punctuation, removes spaces
 * before punctuation, and collapses runs of spaces. It never changes a word.
 */
export function tidyModelText(text: string): string {
  return text
    .replace(/[{}[\]<>`*]/g, "")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/([!?])\.(?!\.)/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
