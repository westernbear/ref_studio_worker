// Escaping for text placed inside a drawtext `text='...'` option.
//
// Getting this wrong is not a cosmetic bug: an unescaped apostrophe closes the
// quote early, so every following clause is parsed as arguments to that
// drawtext and the whole filter graph fails to build -- one OCR label with an
// apostrophe would take out the entire evidence video. A bare `%` is worse in
// the other direction: ffmpeg's text expander eats it silently, so `%{pts}` in
// a label would interpolate and the video would ship looking fine.
//
// Verified against ffmpeg 5.1.9 (the production build) across apostrophes,
// percent signs, `%{...}` expansions, colons, backslashes and Hangul.
export const escapeDrawtext = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll(":", "\\:")
    // A literal apostrophe cannot survive inside the single-quoted option, so
    // hand drawtext the codepoint instead and let it render the character.
    .replaceAll("'", "\\u0027");

export const drawtextFontfile = (
  fontPath = process.env.RVS_FONT_PATH ?? "/opt/rvs/fonts/WantedSansVariable.ttf",
): string => {
  const escaped = fontPath
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\u0027");
  return `fontfile='${escaped}'`;
};
