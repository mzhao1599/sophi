import Image from "next/image";
import Link from "next/link";
import { CtaSentence } from "@/components/landing/CtaSentence";
import { Marquee } from "@/components/landing/Marquee";
import { ModuleBuilder } from "@/components/landing/ModuleBuilder";
import { Reveal } from "@/components/landing/Reveal";
import { WalkerMark } from "@/components/WalkerMark";
import credits from "@/../public/images/found/credits.json";
import styles from "@/components/landing/Landing.module.css";

/*
 * Landing page. taste-skill direction "Loud and flat" (seed 1681769881; hero and about redrawn, see
 * apps/web/README.md). The idea: the walker's own rules (you choose the help, you press start, the
 * stop switch cuts the power) are said at full volume as poster statements, and the walker itself is
 * a flat drawing you build by ticking its parts. The archival prints show the long history of walking
 * frames and are never presented as this walker.
 */

const NAV = [
  ["#how", "How setup works"],
  ["#modules", "Modules"],
  ["#questions", "Questions"],
] as const;

/** The setup, one verb at a time. Each fragment is a real piece of the app, drawn here as it appears there. */
const STEPS = [
  { verb: "Tell", line: "Tell us what you'd like help with.", note: "6 or 7 short questions, one at a time." },
  { verb: "Check", line: "Check what we understood.", note: "Edit or remove any line." },
  { verb: "Choose", line: "Choose your modules.", note: "Each one says why it was suggested." },
  {
    verb: "Pair",
    line: "Pair it with your walker, once the walker is built.",
    note: "One code. It checks what's plugged in before anything starts, and you press start for any arm task, every time.",
  },
] as const;

const LETTER = [
  "We started with one rule: the walker only does what you ask, and you can always stop it.",
  "The assistant runs in the cloud. It can answer a question or suggest a task, like picking up a cup. It can't move anything.",
  "Only the walker can, after it checks its own sensors and limits, and only once you press start.",
  "The stop switch is wired to cut power to the arms and lift directly, without going through software. If the internet drops, the buttons and obstacle cues are designed to keep working.",
  "We ask what you want to do, not what your diagnosis is.",
  "Every suggestion points to something you said, and you can change it.",
  "This is a prototype. Some of it is built and much of it isn't, and we'll always say which is which.",
] as const;

/** Words in the letter that carry a flat highlight: the facts a scanning reader wants. */
const MARKS: Record<string, "yellow" | "pink" | "green"> = {
  "only does what you ask": "yellow",
  "can't move anything": "pink",
  "only once you press start": "yellow",
  "cut power to the arms and lift directly": "green",
  "not what your diagnosis is": "pink",
  "we'll always say which is which": "yellow",
};

const QUESTIONS = [
  [
    "Is this a medical device?",
    "No. It's an experimental prototype built at a hackathon. It isn't certified as a mobility aid and doesn't replace a caregiver or a clinician's advice.",
  ],
  [
    "Do I have to tell you my diagnosis?",
    "No. The setup asks what you'd like to do, where, and how you'd like to be told things. Every suggestion points back to something you said.",
  ],
  [
    "What happens to my answers?",
    "In this demo they're kept in the server's memory for an hour after your last change, then deleted. You can delete them sooner from the top of the setup.",
  ],
  [
    "Can the arms move on their own?",
    "No. The assistant can suggest a task, but the walker checks its own sensors and limits first, and the arms move only after you press start. A stop switch cuts their power directly.",
  ],
  [
    "Does it work without the internet?",
    "The assistant needs a connection. The buttons, the stop switch and obstacle cues are designed to keep working offline; that still has to be tested on the hardware.",
  ],
] as const;

type Credit = {
  file: string;
  title: string;
  creator: string | null;
  license: string;
  licenseUrl: string | null;
  page: string;
  via: string;
  date?: string | null;
};
const CREDITS = credits as Credit[];

/** A paragraph of the letter with its highlighted phrases marked. */
function Marked({ text }: { text: string }) {
  const phrases = Object.keys(MARKS)
    .filter((p) => text.includes(p))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
  if (phrases.length === 0) return <p>{text}</p>;
  const parts: React.ReactNode[] = [];
  let rest = text;
  for (const phrase of phrases) {
    const at = rest.indexOf(phrase);
    parts.push(rest.slice(0, at));
    parts.push(
      <mark key={phrase} className={styles.mark} data-colour={MARKS[phrase]}>
        {phrase}
      </mark>,
    );
    rest = rest.slice(at + phrase.length);
  }
  parts.push(rest);
  return <p>{parts}</p>;
}

/** Interface fragments for the setup steps, built from the app's real wording and the demo's sample answers. */
function StepFragment({ verb }: { verb: (typeof STEPS)[number]["verb"] }) {
  if (verb === "Tell") {
    return (
      <div data-ui className={styles.ui} aria-hidden="true">
        <p className={styles.uiTitle}>What would you like help with?</p>
        <ul className={styles.uiOptions}>
          <li data-on="true">
            <span className={styles.uiBox} />
            Knowing when something is in my way
          </li>
          <li>
            <span className={styles.uiBox} />
            Picking up or reaching for things
          </li>
          <li data-on="true">
            <span className={styles.uiBox} />
            Controls without small, fiddly buttons
          </li>
        </ul>
      </div>
    );
  }
  if (verb === "Check") {
    return (
      <div data-ui className={styles.ui} aria-hidden="true">
        <p className={styles.uiTitle}>What I understood</p>
        <p>You&apos;ll use the walker at home</p>
        <p>“I keep bumping into the door frame in the hallway”</p>
        <p className={styles.uiMeta}>In your words · I took this as knowing when something is in the way</p>
        <p className={styles.uiLinks}>
          <span>Edit</span>
          <span>Remove</span>
        </p>
      </div>
    );
  }
  if (verb === "Choose") {
    return (
      <div data-ui className={styles.ui} aria-hidden="true">
        <p className={styles.uiRow}>
          <span className={styles.uiBox} data-on="true" />
          <span className={styles.uiTitle}>Obstacle sensors</span>
          <span className={styles.uiPill}>Suggested for you</span>
        </p>
        <p>Sensors at the front give you a cue when something is close.</p>
        <p className={styles.uiMeta}>Because: You&apos;d like to know when something is in the way</p>
      </div>
    );
  }
  return (
    <div data-ui className={`${styles.ui} ${styles.uiCode}`} aria-hidden="true">
      <p className={styles.uiMeta}>What the walker would receive, from the demo</p>
      <pre>
        <code>{`{
  "configuration_version": 1,
  "selected_module_ids": [
    "base.walker",
    "controls.hand",
    "perception.tof"
  ],
  "preferences": {
    "cues": ["vibration"],
    "request_start": ["left_button"]
  },
  "source": "demo"
}`}</code>
      </pre>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <Reveal />
      <div className={styles.page}>
        <header className={styles.top} data-field="blue">
          <Link href="/" className={styles.brand}>
            <WalkerMark />
            <span>Assistive Walker</span>
          </Link>
          <nav aria-label="On this page">
            <ul className={styles.nav}>
              {NAV.map(([href, label]) => (
                <li key={href}>
                  <a href={href}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <main id="main">
          {/* Hero: a flush-left shout on ultramarine, a print stuck on across the seam */}
          <section className={styles.hero} aria-labelledby="hero-heading">
            <div className={styles.heroField} data-field="blue">
              <h1 id="hero-heading" className={styles.heroTitle}>
                <span>Only the help</span> <span>you choose</span>
              </h1>
              <figure className={styles.heroScrap}>
                <Image
                  src="/images/found/an-old-man-with-a-beard-in.jpg"
                  alt="A 16th-century engraving of a bearded old man leaning on a wheeled walking frame, under a banner reading Ancora imparo."
                  width={1003}
                  height={1400}
                  priority
                  sizes="(max-width: 760px) 58vw, 30vw"
                />
              </figure>
            </div>
            <div className={styles.heroBand} data-field="black">
              <p className={styles.heroLead}>
                Assistive Walker is an experimental modular walker. Tell it what you&apos;d like help with, then keep only the
                modules that fit.
              </p>
              <Link href="/onboarding" className={styles.action}>
                Start the demo
              </Link>
              <p className={styles.heroCaption}>“Ancora imparo”, I am still learning: an old man in a walking frame, 16th-century engraving.</p>
            </div>
          </section>

          {/* How setup works: one verb at a time */}
          <section id="how" className={styles.how} aria-labelledby="how-heading">
            {STEPS.map((step, i) => (
              <div
                key={step.verb}
                className={styles.step}
                data-field={["yellow", "black", "blue", "pink"][i]}
                data-flip={i % 2 === 1 || undefined}
              >
                {i === 0 ? (
                  <div className={styles.howIntro}>
                    <div className={styles.howIntroText}>
                      <h2 id="how-heading" className={styles.sectionTitle} data-reveal>
                        How setup works
                      </h2>
                      <p className={styles.lead} data-reveal>
                        No forms about your health. A short conversation about what you&apos;d like to do, then a list you can change.
                      </p>
                    </div>
                    <figure className={styles.howScrap} data-reveal>
                      <Image
                        src="/images/found/mother-child-old-man-with-baby-s.jpg"
                        alt="An 18th-century print of an old man holding a small wooden walking frame on wheels beside a mother and child."
                        width={1400}
                        height={1047}
                        sizes="(max-width: 760px) 80vw, 440px"
                      />
                      <figcaption className={styles.caption}>Elisha Kirkall, after a drawing in the Devonshire collection, 1724.</figcaption>
                    </figure>
                  </div>
                ) : null}
                <div className={styles.stepGrid}>
                  <div className={styles.stepWords}>
                    <h3 className={styles.verb} data-reveal>
                      {step.verb}
                    </h3>
                    <p className={styles.stepLine} data-reveal>
                      {step.line}
                    </p>
                    <p className={styles.stepNote} data-reveal>
                      {step.note}
                    </p>
                  </div>
                  <figure className={styles.stepFigure} data-reveal>
                    <StepFragment verb={step.verb} />
                    <figcaption className={styles.caption}>
                      {step.verb === "Pair" ? "Pairing isn't built yet; this is part of the demo's saved configuration." : "As it appears in the app."}
                    </figcaption>
                  </figure>
                </div>
              </div>
            ))}
          </section>

          {/* Modules: the parts list, with the walker drawn beside it */}
          <section id="modules" className={styles.modules} data-field="yellow" aria-labelledby="modules-heading">
            <ModuleBuilder />
          </section>

          <Marquee words="You press start. Every time." />

          {/* Who's in control: the letter, set large, with the facts highlighted */}
          <section className={styles.letter} data-field="blue" aria-labelledby="control-heading">
            <h2 id="control-heading" className={styles.sectionTitle} data-reveal>
              Who&apos;s in control
            </h2>
            <figure className={styles.letterScrap} data-reveal>
              <Image
                src="/images/found/old-man-with-a-walking-stick.jpg"
                alt="An etching of an older man in a hat, his hand resting firmly on the top of a walking stick."
                width={1081}
                height={1400}
                sizes="(max-width: 760px) 52vw, 320px"
              />
              <figcaption className={styles.caption}>Wilhelm Leibl, Old Man with a Walking Stick, 1875–77.</figcaption>
            </figure>
            <div className={styles.letterBody} data-reveal>
              {LETTER.map((p) => (
                <Marked key={p} text={p} />
              ))}
              <p className={styles.signoff}>The Assistive Walker team, Cal Hacks, October 2026</p>
            </div>
          </section>

          {/* Questions: a band per question, every answer visible */}
          <section id="questions" className={styles.faq} aria-labelledby="faq-heading">
            <div className={styles.faqHead} data-field="yellow">
              <div className={styles.faqHeadText}>
                <h2 id="faq-heading" className={styles.sectionTitle} data-reveal>
                  Fair questions
                </h2>
                <ul className={styles.facts} data-reveal>
                  <li>The web setup works today.</li>
                  <li>The walker hardware is being bench-tested.</li>
                  <li>Demo answers are deleted after an hour.</li>
                </ul>
              </div>
              <figure className={styles.faqScrap} data-reveal>
                <Image
                  src="/images/found/two-mothers-with-crying-babies-and-one.jpg"
                  alt="A 16th-century engraving of mothers and children; one small child walks inside a wooden frame on wheels."
                  width={1400}
                  height={1261}
                  sizes="(max-width: 760px) 60vw, 360px"
                />
                <figcaption className={styles.caption}>A child&apos;s walking frame, 16th-century engraving.</figcaption>
              </figure>
            </div>
            <dl className={styles.bands}>
              {QUESTIONS.map(([q, a], i) => (
                <div key={q} className={styles.band} data-field={i % 2 === 0 ? "blue" : "black"}>
                  <dt className={styles.bandQ} data-reveal>
                    {q}
                  </dt>
                  <dd className={styles.bandA} data-reveal>
                    {a}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <CtaSentence />
        </main>
      </div>

      <footer className={styles.footer} data-field="blue">
        <div className={styles.footerMark} aria-hidden="true">
          <svg viewBox="0 0 360 200" className={styles.footerFrame} focusable="false">
            {/* The walker mark, built from flat blocks with 4px seams */}
            <rect x="0" y="0" width="150" height="40" />
            <rect x="210" y="0" width="150" height="40" />
            <rect x="40" y="44" width="40" height="112" />
            <rect x="280" y="44" width="40" height="112" />
            <rect x="84" y="88" width="192" height="28" />
            <circle cx="60" cy="178" r="22" />
            <circle cx="300" cy="178" r="22" />
          </svg>
          <p className={styles.footerName}>Assistive Walker</p>
        </div>
        <div className={styles.footerRow}>
          <ul className={styles.footerPlaces}>
            <li>
              <Link href="/onboarding">Start the demo</Link>
            </li>
            {NAV.map(([href, label]) => (
              <li key={href}>
                <a href={href}>{label}</a>
              </li>
            ))}
          </ul>
          <div className={styles.footerCredits}>
            <h2 className={styles.footerHeading}>Pictures</h2>
            <ul>
              {CREDITS.map((c) => (
                <li key={c.file}>
                  <a href={c.page} rel="noreferrer" target="_blank">
                    {c.title}
                  </a>
                  {c.creator ? `, ${c.creator}` : ""}
                  {c.date ? `, ${c.date}` : ""}.{" "}
                  {c.licenseUrl ? (
                    <a href={c.licenseUrl} rel="noreferrer" target="_blank">
                      {c.license}
                    </a>
                  ) : (
                    c.license
                  )}
                  , via {c.via}.
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className={styles.legal}>
          <p>A prototype. Not a certified mobility aid or a substitute for a caregiver.</p>
          <a href="#main">Back to top</a>
        </div>
      </footer>
    </>
  );
}
