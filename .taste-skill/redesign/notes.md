# Redesign notes (October 2026)

Working notes for the second design of `apps/web`, kept so the next person can see why it looks the
way it does. Inspiration is in [inspiration.md](inspiration.md); the dealt sheets are
`../page/direction.json` (landing) and `../app/direction.json` (app screens).

## What the team said

"It still looks generic." The first design (Instrument Serif greeting, a pale teal field, a centred
white card) was tidy and quiet: nothing was wrong and nothing was decided. Users may have low vision
or limited dexterity, so the redesign had to get louder without getting harder to use.

## Inventory: what only this project has

1. A steel rollator as the base (8-inch wheels), with modules bolted on where they're used.
2. Hand controls: large buttons and a trigger on each handle, with vibration you can feel.
3. Obstacle sensors on the front of the frame that give a cue and never steer or brake.
4. Voice between the handles, answered as speech and as text.
5. Two small robot arms on a lift at the front.
6. The rule: the arms move only after you press start, every time.
7. A stop switch wired to cut power to the arms and lift without going through software.
8. Its output: a versioned configuration the Raspberry Pi receives after pairing.
9. Setup asks what you want to do, never your diagnosis; demo answers are deleted within an hour.
10. Walking frames have a long history in prints: "Ancora imparo", I am still learning.

## Landing

**Argument.** Hero: what it is and that you keep only the help you choose (proof: the sentence and the
demo button). How setup works: a conversation, not a form (proof: the app's real screens). Modules:
every part, where it mounts, what it doesn't do (proof: the live builder). Who's in control: the
arms move only once you press start (proof: the team's letter). Questions: honest answers. Close: start
with your own words.

**Direction.** `loud-flat-poster` ("Loud and flat"), seed 1681769881, chosen from three
(`one-motif`, `name-as-monument`). Why: very large, heavy type and flat full-strength colour are
easier to read for people with low vision, and the project's rules are short things a person says out
loud. Ultramarine against yellow is also the pairing that stays distinct under the common
colour-vision differences.

**Redraws, with reasons.**
- Hero `Square over a moving line` → `Flush-left shout, seam photograph`: the dealt hero's headline
  moves sideways all the time, which fails WCAG 2.2.2 (moving content needs a pause) and is hard to
  read with low vision. Its photograph would also have overlapped the headline, which the house rules
  forbid; the print sits beside the headline instead.
- About `Pinned title, portraits pass` → `Two columns, highlighted words`: there are no team
  portraits, and the archival prints can't stand in for people. The new blueprint holds the team's
  letter word for word. Kept a heading (house rule) and left-aligned text instead of justified (rivers
  in justified text are harder to read with dyslexia).
- How it works `One verb at a time`: kept the verbs as the sequence, but each panel shows the app's own
  fragment beside the verb instead of a photograph behind it, because a fragment behind a giant word
  is unreadable. Panels alternate sides.
- Palette: the dealt pink `#e9479f` was lightened to `#f26db6` so black running text reaches 7.6:1.

**Idea.** On this page, the walker's own rules (you choose the help, you press start, the stop switch
cuts the power) become the poster's blunt statements, and the walker becomes a flat drawing you build
by ticking its parts. Competitor test: a rollator or power-chair page has no arms you press start for
and no modules to choose, so the sentence doesn't fit them.

**Live thing.** The Modules section: tick a module and it is drawn on the walker beside the list, which
stays pinned in view (Framework's configurator, adapted). It uses the real catalog and dependency
rules, announces problems in a polite live region ("Arm lift needs robot arms."), works with the
keyboard and a thumb (56px bars), and renders without script.

**Pictures.** Four credited archival prints (Wellcome Collection CC BY 4.0 ×2, Yale Center for British
Art CC0, Art Institute of Chicago CC0), one treatment (photocopied black and white, stuck on at a
slight angle), each captioned; four interface fragments built from the app's real wording. The walker
itself is drawn; no product photograph exists yet. Video: searched the open collections for "walking
frame" and "rollator" and found no honest clip (an ibis, a horse, dog walkers, a concert), so the
moving picture is the slow sway of the hero print and the moving line.

### Critique

```
ROUND 1
Seen in one second: an ultramarine poster, a white condensed shout, a tilted engraving.
Idea (one sentence): the walker's rules as poster statements; the walker drawn as parts you tick.
Live thing: the module builder.
Layout words by section: hero=shout + arch print / how=verb panels / modules=giant word + bars +
  drawing / band=moving line / control=letter / questions=bands / cta=question at both edges /
  footer=mark built large
Scores: design 6.5 · usability 6 · creativity 7.5 · content 8 → overall 6.8.
Caps applied: inspector FAIL (6.0 cap) until fixed.
Top three problems:
1. The headline is 107px and reaches 41% of the width; at 768px it wraps to three lines (desktop-fold,
   tablet-fold). Fix: size it to the measure, 10.6vw, and move the print right.
2. At 768px the print covers the band's sentence and button (tablet-fold); at 390px it widens the page
   to 426px. Fix: keep the band's text on the left at tablet width; clip sideways overflow.
3. An empty block above "Who's in control" and 11 type sizes. Fix: put the print beside the letter;
   map every size onto six steps.

ROUND 2
Seen in one second: the same, with the headline filling the left and the demo button on the band.
Layout words by section: hero=shout + arch print across the seam / how=verb panels, alternating /
  modules=giant word + filled bars + pinned drawing / band=moving line with pause / control=two-column
  letter + print / questions=heading band + a band per question / cta=question at both edges /
  footer=mark built from blocks + name
Scores: design 7.5 · usability 8 · creativity 7.5 · content 8 → overall 7.7.
Caps applied: none (0 FAIL, four archival pictures, live thing present, the page moves).
Top three problems:
1. The page is long (about 10,000px at 1440); the navigation jumps to each section, but scrolling is
   still work for people with limited dexterity.
2. The interface fragments are set at the app's size inside very large panels, so they read as small
   next to the verbs (desktop-page-01).
3. No product photograph: the walker is a drawing until the hardware exists.
```

## App screens (onboarding and review)

**Style.** `achromatic-ledger`, seed 1253139886, with the landing's palette and type kept
(`--keep palette,type`), chosen over `editorial-greeting` (the first design's style). Why: setup is
done once, by one person who may have low vision, so ink on white with a single hue on what you chose
gives the clearest selected state, and it breaks from the tonal-panel look the team called generic.
The style's move, kept: no colour in the chrome, a near-black primary action, and the one hue
(ultramarine `#1423b8`, 9.9:1 on white) on the main data, which here is your choices: a chosen
answer, a module on your walker, the progress bar, the parts drawn on the walker.

**Shell.** The sheet dealt an icon rail, and redraws only alternated with an open plane. I used the
library's "No sidebar" shell instead (app-screens.md §3.1, "for products with few destinations"):
the app has two destinations, so a rail would be empty chrome. The bar holds the product's mark and
wordmark (the landing's condensed capitals), the demo scope and "Delete my answers"; a sign-in link
can join the same row. `TopBar`'s props are unchanged.

**Face and signature.** Face: the hue on the main data element, plus the landing's type (Archivo; titles
at 800 and 80% width). Signature element: the walker drawing with each module where it mounts, now on
the "That's everything I need" screen too ("Your walker so far", suggestions dashed), where it also
fills what used to be an empty block.

**Each screen's question.**
- Start: "What will this do with my answers?" The "Before you start" notes are the biggest block.
- Question: "What's being asked, and what have I said so far?" The question at 40px, the summary beside it.
- Done: "Is this what I meant?" The summary and the walker so far, then Review modules.
- Review: "Which modules will my walker have?" The list with reasons; the drawing and Save pinned beside it.
- Saved: "What was saved, and what would the walker get?" Modules, cues and the configuration itself.

**Accessibility changes from the sheet.** Body 16px and meta 14px (the sheet says 14 and 12); control
borders `#6e7380` (4.7:1 on white); targets 44px or more (buttons 48px, answer rows 60px); a chosen
answer changes its border colour and fill and shows the native check, so it never relies on colour.

**Check (app-screens.md §2.7).**
1. The biggest thing on each screen answers its question: the question itself, the module list, the
   saved modules. Yes.
2. Shared edges: every block sits on the 1100px column; the saved screen's two halves are one panel
   now (they ended 38px apart as two cards).
3. Colour is on data and the primary action only. The hue shows on the first screen of every step
   (the progress bar, a chosen answer, a module, the drawing).
4. Figures: "Question 3 of 7", "3 of 7 modules" and the progress bar come from the same session values.
5. Empty states: "Nothing yet. Your answers will appear here…" in the summary; the drawing shows the
   frame alone when nothing is suggested.
6. The legend's swatches are the drawing's own marks (solid, dashed in the hue, dashed in grey).
7. Phone: no navigation to fold; the summary moves above the list on review, and every block keeps
   its question.

Inspector warnings kept: `app-title-size` on the question screen (40px; the question is the one thing
to read there, and larger type helps people with low vision) and `below-fold` on review (seven
modules with their reasons don't fit one screen; the summary with Save stays pinned beside the list).
